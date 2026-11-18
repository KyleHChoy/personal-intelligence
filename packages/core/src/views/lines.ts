import {
  type AffiliationRelation,
  type BeliefLine,
  BeliefTier,
  type Cite,
  type CompiledBelief,
  KEY_FIELDS,
  LIFE_DOMAINS,
  type LifeDomain,
  type OwnerSideKind,
  type PersonalBeliefKind,
  type RelationshipRelation,
  SELF_SECTION_LINES,
  SELF_SECTION_PEOPLE,
  type SectionDomain,
  type SectionPerson,
  type SelfSection,
  type Who,
} from "@intelligence/contracts/personal";
import { byText } from "../compare.ts";
import { isThin, useBandOf } from "./line-checks.ts";

// Belief lines. Pure: a belief rendered as one line, the lines ranked, sectioned and collapsed,
// over the rows the caller's token returned alone. Every word of a line is code's, but the cited
// claim's phrase and the names a source gave, so no model prose is stored or served as knowledge.

// What a line shows in place of the phrase of a held cite, whose words the caller cannot read.
export const HELD_PHRASE = "(held)";

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const words = (value: string): string => value.replaceAll("_", " ");
const day = (at: string): string => at.slice(0, 10);
const nameOf = (who: Who | null | undefined): string | undefined =>
  who?.name?.untrusted ?? who?.address?.untrusted ?? undefined;
const joined = (head: string, ...parts: (string | false | undefined)[]): string =>
  [head, ...parts.filter((part): part is string => typeof part === "string")].join(", ");

// The cite's untrusted text field `name`, or undefined for a held cite or a field it lacks.
function citeText(cite: Cite, name: string): string | undefined {
  if (!("fields" in cite)) return undefined;
  const value = (cite.fields as Record<string, unknown>)[name];
  return typeof value === "object" && value !== null && "untrusted" in value && typeof value.untrusted === "string"
    ? value.untrusted
    : undefined;
}

// The phrase a cite gives its belief's line: a role's title, else the claim's `what` (an owner-side
// claim's key phrase, or a legacy claim's whole `what`).
const phraseOf = (cite: Cite): string | undefined => citeText(cite, cite.type === "role" ? "title" : "what");

// A role's or affiliation's organization: the entity's name, else the name its cite gave.
function organizationOf(organization: Who | undefined, cite: Cite): string | undefined {
  if (organization !== undefined) return nameOf(organization);
  const named = citeText(cite, "organization_name");
  if (named !== undefined) return named;
  const fields = "fields" in cite ? (cite.fields as Record<string, unknown>) : {};
  return nameOf(fields.organization as Who | undefined);
}

// `since` is the belief's earliest cite.
function wordsOf(belief: CompiledBelief, cite: Cite, since: string): string {
  const phrase = phraseOf(cite);
  const said = phrase ?? HELD_PHRASE;
  switch (belief.kind) {
    case "goal":
      return joined(`Goal: ${said}`, belief.values.by !== undefined && `by ${belief.values.by}`);
    case "need":
      return joined(`Need: ${said}`, belief.values.by !== undefined && `by ${belief.values.by}`);
    case "capability":
      return `Capability: ${said}`;
    case "preference":
      return `${capital(belief.values.polarity)}: ${said}`;
    case "constraint":
      return joined(`Constraint: ${said}`, belief.values.until !== undefined && `until ${belief.values.until}`);
    case "situation":
      return joined(`Situation: ${said}`, belief.values.until !== undefined && `until ${belief.values.until}`);
    // The owner's view on its topic; an organization's process and its state, in the newest claim's
    // words (the status rule keeps only those); a place the owner has been.
    case "view": {
      const topic = citeText(cite, "topic");
      return topic === undefined ? `View: ${said}` : `View on ${topic}: ${said}`;
    }
    case "status":
      return joined(
        `${citeText(cite, "organization_name") ?? HELD_PHRASE}, ${said}: ${citeText(cite, "state") ?? HELD_PHRASE}`,
        belief.values.since !== undefined && `since ${belief.values.since}`,
      );
    case "visited":
      return joined(`Visited: ${said}`, belief.values.when !== undefined && `in ${belief.values.when}`);
    case "role": {
      const organization = organizationOf(belief.values.organization, cite);
      return joined(
        `${phrase ?? `Role ${HELD_PHRASE}`}${organization === undefined ? "" : ` at ${organization}`}`,
        `since ${day(since)}`,
      );
    }
    case "affiliation": {
      const organization = organizationOf(belief.values.organization, cite);
      return joined(
        `${capital(words(belief.values.relation))}${organization === undefined ? "" : ` at ${organization}`}`,
        `since ${day(since)}`,
      );
    }
    case "relationship":
      return `${capital(words(belief.values.relation))}: ${nameOf(belief.values.counterparty) ?? "someone not named"}`;
    case "commitment":
      return joined(
        `Commitment: ${said}`,
        nameOf(belief.values.counterparty) !== undefined && `with ${nameOf(belief.values.counterparty)}`,
        belief.values.due !== undefined && `due ${belief.values.due}`,
      );
    case "consent":
      return `Consent, ${words(belief.values.about)}: ${said}`;
    case "contact_rule":
      return joined(
        `Contact rule, ${words(belief.values.rule)} by ${belief.values.channel}: ${said}`,
        belief.values.until !== undefined && `until ${belief.values.until}`,
      );
    case "project_status":
      return joined(`Status: ${belief.values.status}`, phrase);
    case "decision":
      return `Decision: ${said}`;
    case "capture_project":
      return "Linked capture item";
  }
}

// The typed deadline a line carries: a goal's, a need's or a commitment's `by`, or a constraint's,
// a situation's or a contact rule's `until`.
function endOf(belief: CompiledBelief): Pick<BeliefLine, "by" | "until"> {
  switch (belief.kind) {
    case "goal":
    case "need":
      return belief.values.by === undefined ? {} : { by: belief.values.by };
    case "commitment":
      return belief.values.due === undefined ? {} : { by: belief.values.due };
    case "constraint":
    case "situation":
    case "contact_rule":
      return belief.values.until === undefined ? {} : { until: belief.values.until };
    default:
      return {};
  }
}

// The cite a notice line names, the belief's first cite whose claim is a system notice's (its
// tier). Undefined when none is, and then the line is no notice line.
export const noticeCite = (belief: CompiledBelief): Cite | undefined =>
  belief.cites.find((one) => "tier" in one && one.tier === "system_notice");

// The kind's template fills in the typed values and the cite's phrase, or HELD_PHRASE for a held
// cite. A line of the `system_notice` tier carries `notice`, the cite's sent time with no sender or
// subject yet: the store, which reads the message under the caller's token, fills those (its
// noticeLines). Its mark is that tier and `notice`, fields code writes beside the words, never
// words added to the untrusted text, so no cut of the words can remove it. Its sent time is its
// notice cite's (noticeCite), and a belief of the tier with no notice cite is rendered as a
// source's line, with no `notice`.
export function renderLine(belief: CompiledBelief, cite: Cite): BeliefLine {
  const times = belief.cites.map((one) => one.at).sort();
  const since = times[0] ?? cite.at;
  const at = times.at(-1) ?? cite.at;
  const domain = "domain" in belief.values ? (belief.values.domain ?? null) : null;
  const channel = "channel" in cite ? cite.channel : undefined;
  const notice = belief.tier === "system_notice" ? noticeCite(belief) : undefined;
  return {
    fact: belief.fact,
    kind: belief.kind,
    domain,
    line: { untrusted: wordsOf(belief, cite, since) },
    tier: belief.tier === "system_notice" && notice === undefined ? "source" : (belief.tier ?? null),
    status: belief.status,
    since,
    at,
    ...endOf(belief),
    cites: belief.cites.length,
    ...(channel === undefined ? {} : { channel }),
    ...(notice === undefined ? {} : { notice: { from: null, subject: null, sentAt: notice.at } }),
  };
}

// A legacy body's `what` stands for the key phrase. The phrase is the agent's slice of the owner's
// quote, so the caller marks the line as the agent's.
export function proposalLine(kind: OwnerSideKind, fields: Readonly<Record<string, unknown>>): string {
  const given = fields[KEY_FIELDS[kind].phrase] ?? fields.what;
  // A view's topic and a status's organization and state are its cite's words too.
  const texts = Object.fromEntries(
    ["topic", "organization_name", "state"].flatMap((name) =>
      typeof fields[name] === "string" ? [[name, { untrusted: fields[name] }]] : [],
    ),
  );
  const cite = {
    type: kind,
    at: "",
    fields: { ...texts, ...(typeof given === "string" ? { what: { untrusted: given } } : {}) },
  } as unknown as Cite;
  const values = {
    polarity: "preference",
    ...Object.fromEntries(
      ["by", "until", "polarity", "since", "when"].flatMap((name) =>
        typeof fields[name] === "string" ? [[name, fields[name]]] : [],
      ),
    ),
  };
  const said = wordsOf({ kind, values, cites: [] } as unknown as CompiledBelief, cite, "");
  const domain = fields.domain;
  return typeof domain === "string" ? said.replace(/^([^:]+):/, `$1 (${words(domain)}):`) : said;
}

// D20: where a role, affiliation or relationship goes, having no domain of its own (E20).
export const AFFILIATION_SECTIONS: Readonly<Record<AffiliationRelation, SectionDomain>> = Object.freeze({
  employee: "career",
  contractor: "career",
  advisor: "career",
  board: "career",
  founder: "ventures",
  owner: "ventures",
  investor: "ventures",
  student: "education",
  alumnus: "education",
  member: "unsorted",
  volunteer: "unsorted",
  other: "unsorted",
});
const FAMILY: ReadonlySet<RelationshipRelation> = new Set(["spouse", "parent", "child", "sibling", "family"]);

export function sectionOf(belief: CompiledBelief): SectionDomain {
  if ("domain" in belief.values && belief.values.domain !== undefined) return belief.values.domain;
  if (belief.kind === "role") return "career";
  if (belief.kind === "affiliation") return AFFILIATION_SECTIONS[belief.values.relation];
  if (belief.kind === "relationship") return FAMILY.has(belief.values.relation) ? "family" : "relationships";
  return "unsorted";
}

const rankOf = (tier: BeliefTier | null | undefined): number =>
  tier === null || tier === undefined ? BeliefTier.options.length : BeliefTier.options.indexOf(tier);

// Every term is the line's own, so a line the caller cannot see moves nothing. With `now`, a first
// read's, useBandOf takes it, and a goal leads its band: what the owner wants comes before what is
// going on.
export function rankLines(
  lines: readonly BeliefLine[],
  tie: ReadonlyMap<string, number> = new Map(),
  now?: Date,
): BeliefLine[] {
  const band = new Map(lines.map((line) => [line, useBandOf(line, now)]));
  const goalLast = (line: BeliefLine): number => (now !== undefined && line.kind === "goal" ? 0 : 1);
  return [...lines].sort(
    (a, b) =>
      (band.get(a) as number) - (band.get(b) as number) ||
      goalLast(a) - goalLast(b) ||
      rankOf(a.tier) - rankOf(b.tier) ||
      byText(b.at, a.at) ||
      (tie.get(b.fact) ?? 0) - (tie.get(a.fact) ?? 0) ||
      byText(a.fact, b.fact),
  );
}

// D19 (E18): the beliefs of one joined set stored under two labels share a `group`; a caller who
// sees both gets one. Keeps, of each group, the first of the highest tier, in the order given;
// a belief in no group is kept.
export function collapseByGroup<T extends { group?: string | undefined; tier?: BeliefTier | null | undefined }>(
  items: readonly T[],
): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    if (item.group === undefined) continue;
    const held = best.get(item.group);
    if (held === undefined || rankOf(item.tier) < rankOf(held.tier)) best.set(item.group, item);
  }
  return items.filter((item) => item.group === undefined || best.get(item.group) === item);
}

// One line with the section it goes in (sectionOf of its belief).
export type SectionedLine = { section: SectionDomain; line: BeliefLine };

const domainOrder = (domain: SectionDomain): number =>
  domain === "unsorted" ? LIFE_DOMAINS.length : LIFE_DOMAINS.indexOf(domain);

// One section per domain with a line, newest `activeAt` first, `unsorted` last. Without `domain`, at most SELF_SECTION_LINES
// lines a section; with it, that section alone and at most that many lines of each kind. At most SELF_SECTION_PEOPLE people a
// section, most claims first. `more` says lines or people were cut. With `now`, a first read's, sections go by the newest line
// about what is going on, those with none after, so a preference or a stale line keeps no section first; `activeAt` still says
// the newest of any. A first read's whole page leaves a fragment off beside anything fuller, unless it is a constraint or the
// owner confirmed it, and says `more`: the domain's read serves it.
export function buildSections(input: {
  lines: readonly SectionedLine[];
  people: ReadonlyMap<SectionDomain, readonly SectionPerson[]>;
  domain?: LifeDomain;
  now?: Date;
}): SelfSection[] {
  const leadAt = new Map<SectionDomain, string>();
  const bySection = new Map<SectionDomain, BeliefLine[]>();
  for (const { section, line } of input.lines) {
    if (input.domain !== undefined && section !== input.domain) continue;
    bySection.set(section, [...(bySection.get(section) ?? []), line]);
  }
  const noticesAlone = new Set<SectionDomain>();
  const sections = [...bySection].map(([domain, lines]): SelfSection => {
    const solid = input.now !== undefined && input.domain === undefined ? lines.filter((one) => !isThin(one)) : [];
    const shown = solid.length > 0 ? solid : lines;
    const kept = input.domain === undefined ? shown.slice(0, SELF_SECTION_LINES) : capPerKind(lines);
    const people = [...(input.people.get(domain) ?? [])].sort(
      (a, b) => b.claims - a.claims || byText(a.who.id, b.who.id),
    );
    // A system's notice arriving is not the owner doing anything in the domain, so a monthly
    // statement does not keep a section first. A section of notices alone has only their time, and
    // goes after every section with something else.
    const others = lines.filter((line) => line.tier !== "system_notice");
    if (others.length === 0) noticesAlone.add(domain);
    const activeAt = (others.length === 0 ? lines : others)
      .map((line) => line.at)
      .sort()
      .at(-1) as string;
    if (input.now !== undefined)
      for (const line of others)
        if (useBandOf(line, input.now) === 0 && line.at > (leadAt.get(domain) ?? "")) leadAt.set(domain, line.at);
    return {
      domain,
      lines: kept,
      people: people.slice(0, SELF_SECTION_PEOPLE),
      activeAt,
      more: kept.length < lines.length || people.length > SELF_SECTION_PEOPLE,
    };
  });
  return sections.sort(
    (a, b) =>
      Number(a.domain === "unsorted") - Number(b.domain === "unsorted") ||
      Number(noticesAlone.has(a.domain)) - Number(noticesAlone.has(b.domain)) ||
      byText(leadAt.get(b.domain) ?? "", leadAt.get(a.domain) ?? "") ||
      byText(b.activeAt, a.activeAt) ||
      domainOrder(a.domain) - domainOrder(b.domain),
  );
}

function capPerKind(lines: readonly BeliefLine[]): BeliefLine[] {
  const counts = new Map<PersonalBeliefKind, number>();
  return lines.filter((line) => {
    const count = counts.get(line.kind) ?? 0;
    counts.set(line.kind, count + 1);
    return count < SELF_SECTION_LINES;
  });
}

// A change is a new `context` version.
export const DOMAIN_KEYWORDS: Readonly<Record<LifeDomain, readonly string[]>> = Object.freeze({
  career: Object.freeze([
    "job",
    "jobs",
    "career",
    "work",
    "role",
    "interview",
    "interviews",
    "resume",
    "cv",
    "hiring",
    "promotion",
    "manager",
    "boss",
    "employer",
    "internship",
    "colleague",
    "colleagues",
    "recruiter",
    "offer",
  ]),
  ventures: Object.freeze([
    "startup",
    "startups",
    "founder",
    "founders",
    "cofounder",
    "venture",
    "ventures",
    "fundraise",
    "fundraising",
    "investor",
    "investors",
    "pitch",
    "seed",
    "angel",
    "business",
    "company",
  ]),
  education: Object.freeze([
    "school",
    "class",
    "classes",
    "course",
    "courses",
    "degree",
    "university",
    "college",
    "exam",
    "exams",
    "study",
    "studying",
    "homework",
    "professor",
    "semester",
    "thesis",
  ]),
  money: Object.freeze([
    "money",
    "budget",
    "bank",
    "invest",
    "investing",
    "investment",
    "stocks",
    "tax",
    "taxes",
    "salary",
    "income",
    "spending",
    "savings",
    "loan",
    "debt",
    "credit",
    "payment",
  ]),
  health: Object.freeze([
    "health",
    "doctor",
    "gym",
    "workout",
    "fitness",
    "sleep",
    "diet",
    "medical",
    "medication",
    "therapy",
    "therapist",
    "dentist",
    "sick",
    "injury",
  ]),
  family: Object.freeze([
    "family",
    "mom",
    "dad",
    "mother",
    "father",
    "parents",
    "sister",
    "brother",
    "sibling",
    "siblings",
    "son",
    "daughter",
    "kids",
    "children",
    "wife",
    "husband",
    "grandmother",
    "grandfather",
  ]),
  relationships: Object.freeze([
    "friend",
    "friends",
    "partner",
    "girlfriend",
    "boyfriend",
    "dating",
    "party",
    "social",
    "wedding",
  ]),
  faith: Object.freeze([
    "faith",
    "church",
    "prayer",
    "pray",
    "mass",
    "bible",
    "temple",
    "mosque",
    "synagogue",
    "worship",
    "religious",
  ]),
  home: Object.freeze([
    "home",
    "apartment",
    "house",
    "lease",
    "rent",
    "landlord",
    "move",
    "moving",
    "roommate",
    "furniture",
    "neighborhood",
  ]),
  travel: Object.freeze([
    "travel",
    "trip",
    "trips",
    "flight",
    "flights",
    "hotel",
    "passport",
    "visa",
    "vacation",
    "airport",
    "itinerary",
  ]),
  interests: Object.freeze([
    "hobby",
    "hobbies",
    "book",
    "books",
    "reading",
    "music",
    "game",
    "games",
    "sport",
    "sports",
    "movie",
    "movies",
    "art",
    "cooking",
  ]),
  admin: Object.freeze([
    "admin",
    "account",
    "accounts",
    "subscription",
    "subscriptions",
    "insurance",
    "bill",
    "bills",
    "renewal",
    "appointment",
    "paperwork",
    "license",
    "registration",
  ]),
});
