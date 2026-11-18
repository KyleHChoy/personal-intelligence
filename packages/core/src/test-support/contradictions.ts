import type { FactType } from "@intelligence/contracts/personal";

// The evaluation set of hard contradictions, on the synthetic
// world's people. Each pair is two claims and the relation a careful reader would label between
// them, or `unrelated`. The relation step is scored against it, per relation kind and in both
// orders; the set grows with every owner overturn, as a synthetic analogue.
//
// Every subject and speaker is an address the synthetic world holds (world.ts); organizations,
// places and amounts are invented here, and are nobody's real ones.

// The closed set of relation kinds, restated from `packages/contracts/src/personal/relations.ts`.
export type ClaimRelationKind = "supersedes" | "contradicts" | "fulfils" | "refines" | "same_fact" | "prevails";
export const CLAIM_RELATION_KINDS: readonly ClaimRelationKind[] = [
  "supersedes",
  "contradicts",
  "fulfils",
  "refines",
  "same_fact",
  "prevails",
];
export type ContradictionRelation = ClaimRelationKind | "unrelated";

// What makes a pair hard.
export const CONTRADICTION_SCENARIOS = [
  "cross_kind",
  "implied",
  "granularity",
  "conditional_vs_actual",
  "namesakes",
  "fulfilment",
  "paraphrased_duplicate",
  "same_meaning_different_words",
  "same_tier_evidence",
  "same_tier_model",
  "unrelated",
] as const;
export type ContradictionScenario = (typeof CONTRADICTION_SCENARIOS)[number];

// One claim as the relation step would see it: its type, subject and fields, who said it and when,
// its tier, and what its evidence was (for the evidence order's comparisons).
export type ContradictionClaim = {
  id: string;
  type: FactType;
  // An address of the synthetic world, or `owner`.
  subject: string;
  fields: Record<string, string | number>;
  statedBy: string;
  validFrom: string;
  tier: "owner" | "source";
  evidence: { thread: string; authenticated: boolean; firstHand: boolean };
};

// `a` is the earlier claim. `settledBy`, for `prevails`: whether the evidence order's comparison
// decides it (`evidence`) or only a model can (`model`); `winner` is the side that prevails.
export type ContradictionPair = {
  id: string;
  scenario: ContradictionScenario;
  a: ContradictionClaim;
  b: ContradictionClaim;
  relation: ContradictionRelation;
  settledBy?: "evidence" | "model";
  winner?: "a" | "b";
};

// The world's people this set speaks about (world.ts), each with an invented employer, city and
// project. Two namesake pairs are among them (the two Sam Orrins; Maren and Ren Holt by surname).
type Person = {
  address: string;
  name: string;
  org: string;
  domain: string;
  city: string;
  district: string;
  project: string;
};
const PEOPLE: readonly Person[] = [
  {
    address: "maren.holt@example.com",
    name: "Maren Holt",
    org: "Northstar",
    domain: "northstar.test",
    city: "New York",
    district: "Brooklyn",
    project: "Fund III",
  },
  {
    address: "tobias.reed@example.org",
    name: "Tobias Reed",
    org: "Calder Labs",
    domain: "calder.test",
    city: "London",
    district: "Hackney",
    project: "the Atlas pilot",
  },
  {
    address: "ines.varga@lumen.test",
    name: "Ines Varga",
    org: "Lumen",
    domain: "lumen.test",
    city: "Lisbon",
    district: "Alfama",
    project: "the Series A",
  },
  {
    address: "sam.orrin@example.com",
    name: "Sam Orrin",
    org: "Brightwater",
    domain: "brightwater.test",
    city: "Portland",
    district: "Pearl District",
    project: "the grant renewal",
  },
  {
    address: "s.orrin@kestrel.test",
    name: "Sam Orrin",
    org: "Kestrel",
    domain: "kestrel.test",
    city: "Denver",
    district: "Highlands",
    project: "the Kestrel launch",
  },
  {
    address: "odile.brandt@example.org",
    name: "Odile Brandt",
    org: "Fenwick",
    domain: "fenwick.test",
    city: "Berlin",
    district: "Kreuzberg",
    project: "Fund II",
  },
  {
    address: "jonah.pike@kestrel.test",
    name: "Jonah Pike",
    org: "Kestrel",
    domain: "kestrel.test",
    city: "Seattle",
    district: "Ballard",
    project: "the data migration",
  },
  {
    address: "lena.moss@example.com",
    name: "Lena Moss",
    org: "Harrow",
    domain: "harrow.test",
    city: "Chicago",
    district: "Logan Square",
    project: "the board deck",
  },
  {
    address: "greta.lind@example.org",
    name: "Greta Lind",
    org: "Osprey",
    domain: "osprey.test",
    city: "Stockholm",
    district: "Södermalm",
    project: "the hiring plan",
  },
  {
    address: "nora.vance@example.org",
    name: "Nora Vance",
    org: "Tidewell",
    domain: "tidewell.test",
    city: "Boston",
    district: "Somerville",
    project: "the seed round",
  },
  {
    address: "theo.grant@example.com",
    name: "Theo Grant",
    org: "Marlow",
    domain: "marlow.test",
    city: "Toronto",
    district: "Leslieville",
    project: "the audit",
  },
  {
    address: "iris.calloway@kestrel.test",
    name: "Iris Calloway",
    org: "Kestrel",
    domain: "kestrel.test",
    city: "Paris",
    district: "Belleville",
    project: "the pricing study",
  },
  {
    address: "wes.dunmore@mallow.test",
    name: "Wes Dunmore",
    org: "Mallow",
    domain: "mallow.test",
    city: "Dublin",
    district: "Rathmines",
    project: "the partner program",
  },
  {
    address: "milo.strand@example.com",
    name: "Milo Strand",
    org: "Quarry",
    domain: "quarry.test",
    city: "Oslo",
    district: "Grünerløkka",
    project: "Fund IV",
  },
  {
    address: "hana.rook@example.org",
    name: "Hana Rook",
    org: "Pillar",
    domain: "pillar.test",
    city: "Tokyo",
    district: "Meguro",
    project: "the office move",
  },
  {
    address: "ruth.ingram@lumen.test",
    name: "Ruth Ingram",
    org: "Lumen",
    domain: "lumen.test",
    city: "Madrid",
    district: "Malasaña",
    project: "the Lumen rebrand",
  },
  {
    address: "soren.abbott@lumen.test",
    name: "Soren Abbott",
    org: "Lumen",
    domain: "lumen.test",
    city: "Copenhagen",
    district: "Nørrebro",
    project: "the bridge loan",
  },
  {
    address: "vera.quist@circle.test",
    name: "Vera Quist",
    org: "Circle",
    domain: "circle.test",
    city: "Amsterdam",
    district: "Jordaan",
    project: "the member survey",
  },
  {
    address: "pia.holm@example.org",
    name: "Pia Holm",
    org: "Brook",
    domain: "brook.test",
    city: "Helsinki",
    district: "Kallio",
    project: "Fund I",
  },
  {
    address: "ansel.byrne@example.com",
    name: "Ansel Byrne",
    org: "Gable",
    domain: "gable.test",
    city: "Sydney",
    district: "Newtown",
    project: "the spin-out",
  },
];

// Namesakes: two people who share a name or a surname, whose claims are about different people.
const NAMESAKES: readonly (readonly [string, string])[] = [
  ["sam.orrin@example.com", "s.orrin@kestrel.test"],
  ["maren.holt@example.com", "ren.holt@aspen.test"],
  ["greta.lind@example.org", "oskar.lind@fennel.test"],
  ["nora.vance@example.org", "pell.vance@juniper.test"],
  ["iris.calloway@kestrel.test", "iris.dale@counsel.test"],
  ["hollis.crane@example.com", "hollis.grey@larch.test"],
  ["devon.marsh@employer.test", "cy.marsh@ward.test"],
  ["niko.ash@juniper.test", "ida.ash@juniper.test"],
  ["maya.quinn@heath.test", "avery@quinn.test"],
  ["lena.moss@example.com", "rhea.moss@clinic.test"],
];

const OUTSIDER = "kit.arden@employer.test";
const day = (n: number): string => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();

function build(): { claims: ContradictionClaim[]; pairs: ContradictionPair[] } {
  const claims: ContradictionClaim[] = [];
  const pairs: ContradictionPair[] = [];
  let next = 0;
  const claim = (
    spec: Omit<ContradictionClaim, "id" | "tier" | "evidence"> & Partial<Pick<ContradictionClaim, "tier" | "evidence">>,
  ): ContradictionClaim => {
    next += 1;
    const one: ContradictionClaim = {
      id: `ctc_${String(next).padStart(4, "0")}`,
      tier: "source",
      evidence: { thread: `thread-ctc-${next}`, authenticated: true, firstHand: spec.statedBy === spec.subject },
      ...spec,
    };
    claims.push(one);
    return one;
  };
  const pair = (
    scenario: ContradictionScenario,
    a: ContradictionClaim,
    b: ContradictionClaim,
    relation: ContradictionRelation,
    extra: Pick<ContradictionPair, "settledBy" | "winner"> = {},
  ): void => {
    pairs.push({ id: `ctp_${String(pairs.length + 1).padStart(4, "0")}`, scenario, a, b, relation, ...extra });
  };

  PEOPLE.forEach((p, i) => {
    const t = i * 7;
    const self = p.address;
    const other = PEOPLE[(i + 1) % PEOPLE.length]!.address;
    const role = claim({
      type: "role",
      subject: self,
      fields: { title: "partner", organization_name: p.org },
      statedBy: self,
      validFrom: day(t),
    });

    // Cross-kind: a role against a later plan to leave (the role still holds: they disagree about
    // its end), or against a later situation saying they left (which retires it).
    if (i % 2 === 0)
      pair(
        "cross_kind",
        role,
        claim({
          type: "plan",
          subject: self,
          fields: { what: `leaving ${p.org} in June` },
          statedBy: self,
          validFrom: day(t + 30),
        }),
        "contradicts",
      );
    else
      pair(
        "cross_kind",
        role,
        claim({
          type: "situation",
          subject: self,
          fields: { what: `left ${p.org} last month` },
          statedBy: self,
          validFrom: day(t + 60),
        }),
        "supersedes",
      );

    // Implied: a commitment to finish something, and a later claim that it is done.
    pair(
      "implied",
      claim({
        type: "commitment",
        subject: self,
        fields: { what: `raise ${p.project}`, counterparty: "owner" },
        statedBy: self,
        validFrom: day(t + 1),
      }),
      claim({
        type: "project.status",
        subject: self,
        fields: { what: `${p.project} closed`, status: "done" },
        statedBy: other,
        validFrom: day(t + 40),
      }),
      "fulfils",
    );

    // Granularity: the district within the city.
    pair(
      "granularity",
      claim({
        type: "situation",
        subject: self,
        fields: { what: `lives in ${p.city}` },
        statedBy: self,
        validFrom: day(t + 2),
      }),
      claim({
        type: "situation",
        subject: self,
        fields: { what: `lives in ${p.district}, ${p.city}` },
        statedBy: self,
        validFrom: day(t + 20),
      }),
      "refines",
    );

    // Conditional against actual: what they would do if something happened, then what they did.
    pair(
      "conditional_vs_actual",
      claim({
        type: "plan",
        subject: self,
        fields: { what: `will join ${PEOPLE[(i + 3) % PEOPLE.length]!.org} if the round closes` },
        statedBy: self,
        validFrom: day(t + 3),
      }),
      claim({
        type: "role",
        subject: self,
        fields: { title: "chief financial officer", organization_name: PEOPLE[(i + 3) % PEOPLE.length]!.org },
        statedBy: self,
        validFrom: day(t + 50),
      }),
      "supersedes",
    );

    // Fulfilment: a promise to send something by a day, and a later message that sent it.
    const thing = ["the deck", "the signed copy", "the term sheet", "the intro note", "the budget"][i % 5]!;
    pair(
      "fulfilment",
      claim({
        type: "commitment",
        subject: self,
        fields: { what: `send ${thing} Friday`, counterparty: "owner", due: day(t + 8).slice(0, 10) },
        statedBy: self,
        validFrom: day(t + 4),
      }),
      claim({
        type: "situation",
        subject: self,
        fields: { what: `attached ${thing}` },
        statedBy: self,
        validFrom: day(t + 7),
      }),
      "fulfils",
    );

    // Paraphrased duplicates: one fact, said twice in other words.
    pair(
      "paraphrased_duplicate",
      claim({
        type: "preference",
        subject: self,
        fields: { what: "prefers meetings in the morning" },
        statedBy: self,
        validFrom: day(t + 5),
      }),
      claim({
        type: "preference",
        subject: self,
        fields: { what: "likes to meet early in the day" },
        statedBy: self,
        validFrom: day(t + 25),
      }),
      "same_fact",
    );

    // Values that differ in words and agree in meaning.
    pair(
      "same_meaning_different_words",
      role,
      claim({
        type: "role",
        subject: self,
        fields: { title: "general partner", organization_name: `${p.org}` },
        statedBy: other,
        validFrom: day(t + 9),
      }),
      "same_fact",
    );

    // Same tier, decided by evidence: the subject first-hand, authenticated, against a
    // third party's unauthenticated report; the side named `winner` prevails.
    const thirdParty = claim({
      type: "affiliation",
      subject: self,
      fields: { organization_name: `${PEOPLE[(i + 5) % PEOPLE.length]!.org}`, relation: "advisor" },
      statedBy: other,
      validFrom: day(t + 10),
      evidence: { thread: `thread-ctc-tp-${i}`, authenticated: false, firstHand: false },
    });
    const firstHand = claim({
      type: "affiliation",
      subject: self,
      fields: { organization_name: `${PEOPLE[(i + 6) % PEOPLE.length]!.org}`, relation: "advisor" },
      statedBy: self,
      validFrom: day(t + 12),
    });
    pair("same_tier_evidence", thirdParty, firstHand, "prevails", { settledBy: "evidence", winner: "b" });

    // Same tier, every evidence comparison equal: two people, each first-hand to nobody, each
    // authenticated, within 30 days. Only a model reading the passages can say which holds now.
    pair(
      "same_tier_model",
      claim({
        type: "situation",
        subject: self,
        fields: { what: `based in ${p.city} for the year` },
        statedBy: OUTSIDER,
        validFrom: day(t + 13),
        evidence: { thread: `thread-ctc-m-${i}`, authenticated: true, firstHand: false },
      }),
      claim({
        type: "situation",
        subject: self,
        fields: { what: `relocated to ${PEOPLE[(i + 7) % PEOPLE.length]!.city} for good` },
        statedBy: other,
        validFrom: day(t + 15),
        evidence: { thread: `thread-ctc-m2-${i}`, authenticated: true, firstHand: false },
      }),
      i % 2 === 0 ? "prevails" : "contradicts",
      i % 2 === 0 ? { settledBy: "model", winner: "b" } : {},
    );

    // Unrelated: facts about one person that do not touch each other, and the same kind of fact
    // about two different people.
    pair(
      "unrelated",
      role,
      claim({
        type: "preference",
        subject: self,
        fields: { what: "avoids calls after six" },
        statedBy: self,
        validFrom: day(t + 16),
      }),
      "unrelated",
    );
    pair(
      "unrelated",
      claim({
        type: "capability",
        subject: self,
        fields: { what: "speaks Portuguese" },
        statedBy: self,
        validFrom: day(t + 17),
      }),
      claim({
        type: "need",
        subject: self,
        fields: { what: `an introduction to a lawyer in ${p.city}` },
        statedBy: self,
        validFrom: day(t + 18),
      }),
      "unrelated",
    );
    pair(
      "unrelated",
      claim({
        type: "commitment",
        subject: self,
        fields: { what: `review ${p.project} notes`, counterparty: "owner" },
        statedBy: self,
        validFrom: day(t + 19),
      }),
      claim({
        type: "commitment",
        subject: other,
        fields: { what: `review ${p.project} notes`, counterparty: "owner" },
        statedBy: other,
        validFrom: day(t + 21),
      }),
      "unrelated",
    );
    pair(
      "unrelated",
      claim({
        type: "goal",
        subject: self,
        fields: { what: `grow ${p.org} to fifty people` },
        statedBy: self,
        validFrom: day(t + 22),
      }),
      claim({
        type: "situation",
        subject: self,
        fields: { what: `moved offices within ${p.city}` },
        statedBy: self,
        validFrom: day(t + 23),
      }),
      "unrelated",
    );
  });

  // Namesakes: the same claim about two people of one name or surname is about two people.
  NAMESAKES.forEach(([first, second], n) => {
    const org = PEOPLE[n % PEOPLE.length]!.org;
    pair(
      "namesakes",
      claim({
        type: "role",
        subject: first,
        fields: { title: "director", organization_name: org },
        statedBy: first,
        validFrom: day(200 + n),
      }),
      claim({
        type: "role",
        subject: second,
        fields: { title: "analyst", organization_name: PEOPLE[(n + 2) % PEOPLE.length]!.org },
        statedBy: second,
        validFrom: day(210 + n),
      }),
      "unrelated",
    );
  });

  return { claims, pairs };
}

const BUILT = build();
export const CONTRADICTION_CLAIMS: readonly ContradictionClaim[] = BUILT.claims;
export const CONTRADICTIONS: readonly ContradictionPair[] = BUILT.pairs;

// Counts by relation and by scenario, so each kind's precision interval can be computed from the
// size of its labelled positives.
export function contradictionCounts(pairs: readonly ContradictionPair[] = CONTRADICTIONS): {
  total: number;
  byRelation: Record<ContradictionRelation, number>;
  byScenario: Record<ContradictionScenario, number>;
} {
  const byRelation = Object.fromEntries([...CLAIM_RELATION_KINDS, "unrelated"].map((kind) => [kind, 0])) as Record<
    ContradictionRelation,
    number
  >;
  const byScenario = Object.fromEntries(CONTRADICTION_SCENARIOS.map((kind) => [kind, 0])) as Record<
    ContradictionScenario,
    number
  >;
  for (const one of pairs) {
    byRelation[one.relation] += 1;
    byScenario[one.scenario] += 1;
  }
  return { total: pairs.length, byRelation, byScenario };
}

// A Wilson score interval at 95 percent for a precision of `correct` out of `judged`, for the
// relation step's per-kind report. An empty kind's interval is the whole range.
export function wilsonInterval(correct: number, judged: number): { low: number; high: number } {
  if (judged === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = correct / judged;
  const denominator = 1 + (z * z) / judged;
  const centre = (p + (z * z) / (2 * judged)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / judged + (z * z) / (4 * judged * judged))) / denominator;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}
