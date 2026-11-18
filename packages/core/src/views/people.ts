import {
  type CompiledBelief,
  type CompiledFacts,
  type CurrentStanding,
  OPEN_BELIEF_STATUS,
  type Who,
} from "@intelligence/contracts/personal";
import { byText } from "../compare.ts";
import { byBeliefOrder } from "./facts.ts";
import { rankLines, renderLine } from "./lines.ts";

// People reads. Pure: the store hands in what the caller's token returned, and every order, pick
// and score here is over those rows alone, so a row the caller cannot see changes nothing.

const fold = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .join(" ");

type Role = Extract<CompiledBelief, { kind: "role" }>;
type Affiliation = Extract<CompiledBelief, { kind: "affiliation" }>;

// The latest cite's fields, or none when that cite is held.
const latestFields = (belief: CompiledBelief): Readonly<Record<string, unknown>> | undefined => {
  const cite = belief.cites[0];
  return cite !== undefined && "fields" in cite ? (cite.fields as Record<string, unknown>) : undefined;
};
const untrustedField = (belief: CompiledBelief, name: string): { untrusted: string } | null => {
  const value = latestFields(belief)?.[name];
  return typeof value === "object" && value !== null && "untrusted" in value && typeof value.untrusted === "string"
    ? { untrusted: value.untrusted }
    : null;
};

// Fields that move without making another fact (the fact key's value fields).
const VALUE_FIELDS: ReadonlySet<string> = new Set(["until", "by", "status"]);

// What a belief says with its subject taken away, every entity named by its group: two members'
// beliefs with one key are one fact of the group. A belief whose latest cite is held shows no
// fields, and keys by its own fact, so it is never collapsed.
export function groupFactKey(belief: CompiledBelief, groupOf: (id: string) => string): string {
  const fields = latestFields(belief);
  if (fields === undefined) return `fact:${belief.fact}`;
  const named = Object.entries(fields)
    .filter(([name]) => !VALUE_FIELDS.has(name))
    .map(([name, value]): [string, unknown] => {
      if (typeof value === "object" && value !== null && "untrusted" in value && typeof value.untrusted === "string")
        return [name, fold(value.untrusted)];
      if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string")
        return [name, `entity:${groupOf(value.id)}`];
      return [name, value];
    })
    .sort(([a], [b]) => byText(a, b));
  return JSON.stringify([belief.kind, belief.type, named]);
}

// A group's beliefs, one per group fact key: the first of each in compileFacts' order (open first,
// then the latest confirmed, then by fact), so which member's copy is served turns on the rows
// given alone. A group of one keeps every belief.
export function collapseGroup(beliefs: readonly CompiledBelief[], groupOf: (id: string) => string): CompiledBelief[] {
  const order = (one: CompiledBelief) => ({ ...one, subjectKind: "person" as const });
  const kept = new Map<string, CompiledBelief>();
  for (const belief of [...beliefs].sort((a, b) => byBeliefOrder(order(a), order(b)))) {
    const key = groupFactKey(belief, groupOf);
    if (!kept.has(key)) kept.set(key, belief);
  }
  const keep = new Set(kept.values());
  return beliefs.filter((one) => keep.has(one));
}

// An affiliation that is a job: a newer one at another organization ends an older role.
const EMPLOYMENT: ReadonlySet<string> = new Set(["employee", "founder", "owner", "contractor"]);

// When a belief started, as far as its served cites tell: the earliest of them.
export const sinceOf = (belief: CompiledBelief): string =>
  belief.cites.map((cite) => cite.at).reduce((earliest, at) => (Date.parse(at) < Date.parse(earliest) ? at : earliest));

// The organization a role or an affiliation is at: its entity's id, else its latest cite's
// organization name folded, else none.
const organizationOf = (belief: Role | Affiliation): string | null => {
  const entity = belief.values.organization;
  if (entity !== undefined) return `entity:${entity.id}`;
  const name = untrustedField(belief, "organization_name");
  return name === null ? null : `name:${fold(name.untrusted)}`;
};

// Latest by since, then by confirmation, then by fact.
const byLatest = (a: CompiledBelief, b: CompiledBelief): number =>
  Date.parse(sinceOf(b)) - Date.parse(sinceOf(a)) ||
  Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt) ||
  byText(a.fact, b.fact);

// The current role and affiliation among the beliefs: open ones alone (active or stale; never a
// dormant, expired or closed one), the latest of each. A role at a known organization ends when an
// open employment affiliation at another one started after it. Nothing is stored: fact keys stay
// per organization.
export function currentOf(beliefs: readonly CompiledBelief[]): { role?: Role; affiliation?: Affiliation } {
  const open = beliefs.filter((one) => OPEN_BELIEF_STATUS.has(one.status));
  const affiliations = open.filter((one): one is Affiliation => one.kind === "affiliation").sort(byLatest);
  const jobs = affiliations.filter((one) => EMPLOYMENT.has(one.values.relation));
  const roles = open
    .filter((one): one is Role => one.kind === "role")
    .filter((role) => {
      const at = organizationOf(role);
      if (at === null) return true;
      const since = Date.parse(sinceOf(role));
      return !jobs.some(
        (job) => Date.parse(sinceOf(job)) > since && organizationOf(job) !== null && organizationOf(job) !== at,
      );
    })
    .sort(byLatest);
  const [role] = roles;
  const [affiliation] = affiliations;
  return { ...(role === undefined ? {} : { role }), ...(affiliation === undefined ? {} : { affiliation }) };
}

// The card's `current`, from currentOf's picks: a role's title and an organization named only by
// name from the latest cite.
export function currentStanding(beliefs: readonly CompiledBelief[]): CurrentStanding {
  const { role, affiliation } = currentOf(beliefs);
  const organization = (belief: Role | Affiliation): Who | null => belief.values.organization ?? null;
  return {
    ...(role === undefined
      ? {}
      : {
          role: {
            title: untrustedField(role, "title"),
            organization: organization(role),
            organizationName: untrustedField(role, "organization_name"),
            since: sinceOf(role),
          },
        }),
    ...(affiliation === undefined
      ? {}
      : {
          affiliation: {
            relation: affiliation.values.relation,
            organization: organization(affiliation),
            organizationName: untrustedField(affiliation, "organization_name"),
            since: sinceOf(affiliation),
          },
        }),
  };
}

// ---------------------------------------------------------------------------------------------
// get_entity's cap
// ---------------------------------------------------------------------------------------------

export const CARD_BELIEFS = 30;
const CARD_CITES = 1;

// At most CARD_BELIEFS beliefs, kept in the order given, each with its latest cite alone. `more`
// when a belief was cut; a cite past the first is never `more`, since get_beliefs and find_facts
// serve every cite.
export function capFacts(facts: CompiledFacts, pinned: ReadonlySet<string>): CompiledFacts {
  const head = (one: CompiledBelief): boolean =>
    pinned.has(one.fact) || (one.kind === "relationship" && one.values.counterparty.kind === "owner");
  const pins = facts.beliefs.filter(head).slice(0, CARD_BELIEFS);
  const rest = facts.beliefs.filter((one) => !pins.includes(one));
  const lineOf = new Map(
    rest.flatMap((one) => (one.cites[0] === undefined ? [] : [[renderLine(one, one.cites[0]), one] as const])),
  );
  const chosen = new Set([
    ...pins,
    ...rankLines([...lineOf.keys()])
      .flatMap((line) => lineOf.get(line) ?? [])
      .slice(0, CARD_BELIEFS - pins.length),
  ]);
  const kept = facts.beliefs.filter((one) => chosen.has(one));
  return {
    beliefs: kept.map((one) => ({ ...one, cites: one.cites.slice(0, CARD_CITES) }) as CompiledBelief),
    claims: facts.claims,
    more: facts.more || kept.length < facts.beliefs.length,
  };
}

// Tie strength lives in the warmth tier (warmth.ts, ranked at read from the store's warmth days), and
// find_paths' order in paths.ts' rankPathsByWeakestHop.
