import type { HumanDecision } from "@intelligence/contracts";
import {
  type BeliefClaim,
  type FactReclassification,
  type FactRetirement,
  KEY_FIELDS,
  LIFE_DOMAINS,
  type OwnerSideKind,
  RULABLE_KINDS,
} from "@intelligence/contracts/personal";
import { legacyFactKeys } from "./fact-key.ts";
import { personalType } from "./ontology.ts";

// The owner's domain and kind rulings, and the owner's rulings made before fact key version 2, as the
// belief build applies them. Pure: the store reads the rulings; nothing here reads a model's words.

const at = (time: string): number => Date.parse(time);

// The version 1 keys a version 2 claim record carries, so a ruling keyed by version 1 still reaches
// it (`legacyFactKeys`): its own word's as `legacyFactKey`, and a preference's synonym's as
// `legacyAltFactKey`.
export function legacyKeysOf(...keyed: Parameters<typeof legacyFactKeys>): {
  legacyFactKey: string;
  legacyAltFactKey?: string;
} {
  const [own, alt] = legacyFactKeys(...keyed);
  return { legacyFactKey: own as string, ...(alt === undefined ? {} : { legacyAltFactKey: alt }) };
}
const ownerSide = (type: string): type is OwnerSideKind => Object.hasOwn(KEY_FIELDS, type);

// What the owner may rule. A domain from the closed list, for an owner-side kind; a kind
// among the owner-side kinds, from another of them, but a preference, whose polarity no ruling gives.
export const rulableDomain = (type: string, domain: string): boolean =>
  ownerSide(type) && (LIFE_DOMAINS as readonly string[]).includes(domain);
// Among the kinds of RULABLE_KINDS and a preference only, so a status or a
// visit, whose organization, state or place no ruling gives, is never ruled to or from.
const RULED: ReadonlySet<string> = new Set([...RULABLE_KINDS, "preference"]);
export const rulableKind = (type: string, kind: string): boolean =>
  ownerSide(type) &&
  ownerSide(kind) &&
  RULED.has(type) &&
  (RULABLE_KINDS as readonly string[]).includes(kind) &&
  type !== kind;

// A claim's content under a kind ruling: the type the owner gave, its key phrase moved to that
// kind's phrase field, and every field the new kind does not declare left out (a goal's `by` as a
// situation, a situation's `momentary` as a goal). A legacy `what` stays as it is.
function rekinded(content: BeliefClaim["claim"]["content"], kind: OwnerSideKind): BeliefClaim["claim"]["content"] {
  const from = ownerSide(content.type) ? KEY_FIELDS[content.type].phrase : undefined;
  const to = KEY_FIELDS[kind].phrase;
  const declared = new Set((personalType(kind)?.fields ?? []).map((field) => field.name));
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(content.fields)) {
    const named = name === from ? to : name;
    if (declared.has(named)) fields[named] = value;
  }
  return { ...content, type: kind, fields };
}

// A ruling binds the fact key it names; its claims keep their ids, so the belief keeps its support,
// and the belief keeps its fact key. A ruling of a value no longer allowed changes nothing.
export function reclassify(
  claims: readonly BeliefClaim[],
  factKeyFp: string,
  rulings: readonly FactReclassification[],
  covers: (compartments: readonly string[]) => boolean,
): BeliefClaim[] {
  const latest = (verdict: FactReclassification["verdict"]): FactReclassification | undefined =>
    rulings
      .filter((one) => one.verdict === verdict && one.factKeyFp === factKeyFp && covers(one.compartments))
      .reduce<FactReclassification | undefined>(
        (best, one) => (best === undefined || at(one.at) > at(best.at) ? one : best),
        undefined,
      );
  const kind = latest("kind");
  const domain = latest("domain");
  if (kind === undefined && domain === undefined) return [...claims];
  return claims.map((one) => {
    let content = one.claim.content;
    if (kind !== undefined && rulableKind(content.type, kind.value))
      content = rekinded(content, kind.value as OwnerSideKind);
    if (domain !== undefined && rulableDomain(content.type, domain.value))
      content = { ...content, fields: { ...content.fields, domain: domain.value } };
    return content === one.claim.content ? one : { ...one, claim: { ...one.claim, content } };
  });
}

// Whether a veto or a retire made before fact key version 2 went live (`goAt`), carried to this
// claim by its version 1 key and its item (the store's `carried`), leaves it out for an audience. A
// carried veto leaves out a claim dated before `goAt`; a carried retire one dated at or before the
// retire, as the retire held it (a claim dated after it reopened the fact). A ruling an audience
// cannot read changes nothing for it. A reject is carried by the store, by its item; a confirmation
// by its claim key.
export function carriedOut(
  one: BeliefClaim,
  vetoes: readonly HumanDecision[],
  retirements: readonly FactRetirement[],
  goAt: string | null,
  covers: (compartments: readonly string[]) => boolean,
): boolean {
  const carried = one.carried ?? [];
  if (carried.length === 0) return false;
  const dated = at(one.claim.validFrom);
  const vetoed =
    goAt !== null &&
    dated < at(goAt) &&
    vetoes.some((veto) => carried.includes(veto.id) && covers(veto.label.compartments));
  return (
    vetoed ||
    retirements.some((retire) => carried.includes(retire.id) && covers(retire.compartments) && dated <= at(retire.at))
  );
}
