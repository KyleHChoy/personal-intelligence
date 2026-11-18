import { type IntroOffer, SecondDegreeRules, type SecondDegreeTie } from "@intelligence/contracts/personal";
import { byText } from "../compare.ts";
import { repoFile } from "../repo-root.ts";

// A hop weight outside 0 to 1 is refused.

export const secondDegreeRules: () => SecondDegreeRules = repoFile("ontology/second-degree.json", (text) =>
  SecondDegreeRules.parse(JSON.parse(text)),
);

// `person` names them, `tie` and `offer` the hop, `goal` whether an active goal the caller can see
// targets them, `at` the cited claim's date and `fact` its id. `heard`: a claim of a meeting or a
// chat not linked to an event, listed but never a hop.
export type PrepCandidate = {
  person: string;
  tie: SecondDegreeTie;
  offer?: IntroOffer;
  heard?: boolean;
  goal: boolean;
  at: string;
  fact: string;
};

// A heard claim, which is no hop, after every hop.
const KIND_ORDER: Readonly<Record<SecondDegreeTie, number>> = Object.freeze({
  intro_offer: 0,
  relationship: 2,
  acquaintance: 3,
  connection: 4,
  researched: 5,
  reported: 6,
});
const HEARD = 7;
const kindRank = (one: PrepCandidate): number =>
  one.heard === true ? HEARD : one.tie === "intro_offer" && one.offer !== "offered" ? 1 : KIND_ORDER[one.tie];

export function prepOrder<T extends PrepCandidate>(candidates: readonly T[], cap: number): T[] {
  const ordered = [...candidates].sort(
    (a, b) =>
      Number(b.goal) - Number(a.goal) ||
      kindRank(a) - kindRank(b) ||
      byText(b.at, a.at) ||
      byText(a.fact, b.fact) ||
      byText(a.person, b.person),
  );
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const one of ordered) {
    if (kept.length >= cap) break;
    if (seen.has(one.person)) continue;
    seen.add(one.person);
    kept.push(one);
  }
  return kept;
}
