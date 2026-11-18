import type { LocalEntityId } from "@intelligence/contracts";
import { KEY_FIELDS, type OwnerSideKind } from "@intelligence/contracts/personal";
import { wordsCovered } from "@intelligence/personal-beliefs";
import type { CaptureTally } from "../capture-check.ts";
import type { EvalMeetingFact } from "./eval-meetings-set.ts";

// What the lanes' evaluations share: a fact's shape, whether a found claim states an expected fact,
// and what a pooled run reports.

// One fact's shape for `--detail`: its type, who it is of and owed to, by role in the synthetic
// set (the owner, the other speaker, or someone the set does not hold), its due day and a plan's day.
export type MeetingFactShape = {
  type: string;
  subject: MeetingRole;
  counterparty: MeetingRole;
  due: string | null;
  when: string | null;
};

type MeetingRole = "owner" | "other" | "unknown" | "none";

// A fact's shape, its subject and counterparty by role against a set's owner entity and the
// entities of its other people. The moment evaluation shapes its facts the same way.
export const shapeOf =
  (owner: LocalEntityId, others: ReadonlySet<LocalEntityId>) =>
  (fact: {
    type: string;
    subject: unknown;
    counterparty: unknown;
    due?: unknown;
    when?: unknown;
  }): MeetingFactShape => {
    const roleOf = (entity: unknown): MeetingRole =>
      entity === undefined || entity === null
        ? "none"
        : entity === owner
          ? "owner"
          : others.has(entity as LocalEntityId)
            ? "other"
            : "unknown";
    const dayOf = (day: unknown): string | null => (typeof day === "string" ? day : null);
    return {
      type: fact.type,
      subject: roleOf(fact.subject),
      counterparty: roleOf(fact.counterparty),
      due: dayOf(fact.due),
      when: dayOf(fact.when),
    };
  };

// A claim's words, for `--detail`: an owner-side kind's key phrase, a role's title, an
// affiliation's organization, a commitment's or a plan's statement.
export function saidIn(type: string, fields: Record<string, unknown>): string {
  const field = Object.hasOwn(KEY_FIELDS, type)
    ? KEY_FIELDS[type as OwnerSideKind].phrase
    : type === "role"
      ? "title"
      : type === "affiliation"
        ? "organization_name"
        : "what";
  return String(fields[field] ?? "");
}

// Whether a found claim states an expected fact, by its type, subject, polarity and the people it
// names, then its words: at least SAME_WORDS of the expected phrase's content words (or of any
// phrasing it accepts), each as itself or with another ending, for an owner-side kind, a role's
// title and an affiliation's organization; a commitment's or a plan's statement as `sameStatement`
// reads it; a relationship by its relation. Domain and due are not read here.
const SAME_WORDS = 0.6;

const NEGATED = /\b(?:not|no|never|cannot|can't|won't|don't|doesn't|isn't|aren't|without)\b/iu;

// The moment check matches by the same rule, under its own people's entities.
export type FoundFact = {
  type: string;
  subject: string;
  counterparty: unknown;
  what: unknown;
  said: string;
  fields: Record<string, unknown>;
};

export const sameFactOf =
  (entityOf: (address: string) => string) =>
  (fact: EvalMeetingFact, one: FoundFact): boolean => {
    if (one.type !== fact.type || one.subject !== entityOf(fact.subject)) return false;
    switch (fact.type) {
      case "commitment":
      case "plan":
        return one.counterparty === entityOf(fact.counterparty) && sameStatement(fact.what, one.what);
      case "relationship":
        return one.counterparty === entityOf(fact.counterparty) && one.fields.relation === fact.relation;
      case "role":
        return wordsCovered(fact.title, one.said) >= SAME_WORDS;
      case "affiliation":
        return one.fields.relation === fact.relation && wordsCovered(fact.organization, one.said) >= SAME_WORDS;
      default:
        if (fact.polarity !== undefined && one.fields.polarity !== fact.polarity) return false;
        // A phrase with its negation dropped, or one added, states the opposite.
        return [fact.phrase, ...(fact.also ?? [])].some(
          (phrase) => NEGATED.test(phrase) === NEGATED.test(one.said) && wordsCovered(phrase, one.said) >= SAME_WORDS,
        );
    }
  };

// Whether a found statement is the expected one's: a commitment's and a plan's fact key holds no
// text, so at least half the expected statement's words must be in the stored one.
const WORDS = /[\p{L}\p{N}']+/gu;

export const sameStatement = (expected: string | undefined, found: unknown): boolean => {
  if (expected === undefined) return true;
  // A promise with its negation dropped, or one added, is another promise.
  if (NEGATED.test(expected) !== (typeof found === "string" && NEGATED.test(found))) return false;
  const have = new Set((typeof found === "string" ? found.toLowerCase().match(WORDS) : null) ?? []);
  const want = [...new Set(expected.toLowerCase().match(WORDS) ?? [])];
  return want.filter((word) => have.has(word)).length * 2 >= want.length;
};

// A pooled run's own name for an item (`run2/...`). A pooled report's detail names each item and
// its evidence id by run, since every run asks the same synthetic evidence ids.
export const runKey = (run: number, id: string): string => `run${run}/${id}`;

export const shapeText = (shape: MeetingFactShape): string =>
  `${shape.type}/${shape.subject}>${shape.counterparty}/due=${shape.due ?? "none"}${shape.when === null ? "" : `/when=${shape.when}`}`;

// Each missed or extra shape more than half the runs share, by item, with how many runs show it;
// the moment check's pooled runs, the same way.
export function systematicOf(runs: readonly (readonly MeetingDetail[])[]): string[] {
  const n = runs.length;
  return (runs[0] ?? []).flatMap((item) => {
    const runsOf = runs.map((one) => one.find((other) => other.id === item.id));
    const shared = (kind: "missed" | "extra"): string[] => {
      const shown = new Map<string, number>();
      for (const one of runsOf)
        for (const text of new Set((one?.[kind] ?? []).map(shapeText))) shown.set(text, (shown.get(text) ?? 0) + 1);
      return [...shown]
        .filter(([, count]) => count * 2 > n)
        .map(([text, count]) => `${item.id} ${kind} ${text} in ${count} of ${n}`);
    };
    return [...shared("missed"), ...shared("extra")];
  });
}

export type MeetingProposal = {
  type: string;
  subject: string;
  said: string;
  relation?: string;
  domain: string;
  span: string;
  outcome: string;
};

export type MeetingDetail = {
  id: string;
  evidenceId: string;
  // Every evidence id its requests were asked under, when more than `evidenceId` (a moment group
  // split in halves); its detail line counts them all.
  evidenceIds?: string[];
  answered: boolean;
  expected: number;
  matched: number;
  missed: MeetingFactShape[];
  extra: MeetingFactShape[];
  drops?: CaptureTally;
  proposals?: MeetingProposal[];
  missedSaid?: string[];
  extraSaid?: string[];
  // Each refused answer's shape, counts under fixed names (rejectionShape).
  rejected?: string[];
};
