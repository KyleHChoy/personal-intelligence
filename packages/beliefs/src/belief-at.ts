import type { Claim, HumanDecision, Timestamp } from "@intelligence/contracts";
import type {
  BeliefCheckMark,
  BeliefClaim,
  BeliefRecord,
  BeliefRelation,
  BeliefSettlement,
  CommitmentReopen,
  FactGrouping,
  FactReclassification,
  FactRetirement,
  FactRuling,
  GroupingMode,
  PersonalBeliefKind,
  RelationSwitchRow,
} from "@intelligence/contracts/personal";
import { ABOUT_YOU_PIPELINES } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { BELIEF_RULES, settle, stated } from "./belief-rules.ts";
import { carriedOut, reclassify } from "./belief-rulings.ts";
import { buildBelief } from "./build-belief.ts";
import { type ReadSettlement, readSettlements, unsupportedFor } from "./dream-marks.ts";
import { canonicalClaim, groupOf, joinedSets } from "./fact-groups.ts";
import { PERSONAL_ONTOLOGY } from "./ontology.ts";
import { currentClaims, lifecycleOf, retiredBy } from "./owner-time.ts";
import { judgeKindOf, prevailHolds, type ReadRelation, readRelations, supersededIn } from "./relations.ts";
import { beliefTier } from "./tier.ts";

// One audience's beliefs, computed from the claims and rulings given. The extraction's rebuild and
// a read both call this, so they compute a belief the same way. Pure: no model, no stored output,
// no clock but `asOf`. The applied relations the audience can see act on it: before buildBelief, an
// applied `supersedes` or `refines` removes the claim it bounds, an applied `fulfils` closes the
// commitment it names, and an applied `same_fact` across two keys joins them as code's grouping
// does; after it, an applied `contradicts` marks the belief disputed and an applied `prevails`
// settles a dispute.

// What the store gives the build: every claim of a type that builds a belief, grouped by its
// stored fact key (`beliefClaims`), and the rulings in force (`beliefDecisions`, without its mark).
export type BeliefInputs = {
  groups: { factKeyFp: string; claims: BeliefClaim[] }[];
  decisions: HumanDecision[];
  retirements: FactRetirement[];
  reclassifications: FactReclassification[];
  goAt: Timestamp | null;
  reopens?: CommitmentReopen[];
  factRulings?: FactRuling[];
  groupings?: FactGrouping[];
  groupingMode?: GroupingMode;
  // The relations by claim key that the reader's statements gave (the store holds them to the
  // caller's clearance), and the relation kinds' switch rows.
  relations?: BeliefRelation[];
  switches?: RelationSwitchRow[];
  // The agents' settlements in force, and the model checks of beliefs, as the
  // store gives them to the caller's clearance.
  settlements?: BeliefSettlement[];
  beliefChecks?: BeliefCheckMark[];
};

// The rows built, and the counts the rebuild adds to its run's summary: `refused`, the joined sets
// not joined; `mixed`, a key or a part whose claims hold more than one
// compartment set; `failed`, a belief buildBelief refused.
export type BeliefsFor = { rows: BeliefRecord[]; refused: number; mixed: number; failed: number };

// Each kind's rule, by the claim's type. The store gives the claims of BELIEF_TYPES alone, the
// types whose kind has a row (a test holds the two equal); an agent record's only when the owner
// confirmed it.
const ruleOf = (claim: Claim) => {
  const kind = PERSONAL_ONTOLOGY.get(claim.content.type)?.beliefKind as PersonalBeliefKind | undefined;
  return kind === undefined ? undefined : BELIEF_RULES[kind];
};

const covers = (audience: readonly string[], compartments: readonly string[]): boolean =>
  compartments.every((compartment) => audience.includes(compartment));
const within = (claim: Claim, audience: readonly string[]): boolean => covers(audience, claim.label.compartments);
const compartmentsOf = (claim: Claim): string => JSON.stringify([...claim.label.compartments].sort());

type Rule = NonNullable<ReturnType<typeof ruleOf>>;
type Prepared = { factKeyFp: string; kept: BeliefClaim[]; rule: Rule };
// The earliest claim first, then by id.
const earliest = (a: BeliefClaim, b: BeliefClaim): number =>
  Date.parse(a.claim.validFrom) - Date.parse(b.claim.validFrom) ||
  (a.claim.id < b.claim.id ? -1 : a.claim.id > b.claim.id ? 1 : 0);

// What every row of one build reads: the audience, its time, the rulings, and the relations it sees.
type Build = {
  audience: readonly string[];
  asOf: Timestamp;
  decisions: HumanDecision[];
  retirements: FactRetirement[];
  reopens: CommitmentReopen[];
  factRulings: FactRuling[];
  groupingMode: GroupingMode;
  readable: (compartments: readonly string[]) => boolean;
  applied: ReadRelation[];
  claimById: Map<string, BeliefClaim>;
  groupings: FactGrouping[];
  settlements: ReadSettlement[];
  beliefChecks: BeliefCheckMark[];
};

// The beliefs of one audience, as of `asOf`, from `inputs`. With `factKeys`, only the rows built
// under one of those keys, or joined from one (`members`), are returned; the counts are the whole
// build's. A joined set needs every key's claims in `inputs`: the store's keyed reads give them.
export function beliefsFor(
  inputs: BeliefInputs,
  audience: readonly string[],
  asOf: Timestamp,
  factKeys?: readonly string[],
): BeliefsFor {
  const { decisions, retirements, reclassifications, goAt, factRulings = [], groupingMode = "shadow" } = inputs;
  const reopens = inputs.reopens ?? [];
  const out: BeliefsFor = { rows: [], refused: 0, mixed: 0, failed: 0 };
  const readable = (compartments: readonly string[]): boolean => covers(audience, compartments);
  const ctx: Build = {
    audience,
    asOf,
    decisions,
    retirements,
    reopens,
    factRulings,
    groupingMode,
    readable,
    ...appliedRelations(inputs, audience, asOf),
    settlements: readSettlements(
      inputs.groups.flatMap((group) => group.claims),
      inputs.settlements ?? [],
      audience,
      asOf,
    ),
    beliefChecks: inputs.beliefChecks ?? [],
  };
  const prepared = prepare(inputs.groups, ctx, reclassifications, goAt);
  const { sets, inSet } = joinPrepared(prepared, ctx, out);

  // A row has one compartment set, judged for this audience by itself.
  for (const one of prepared) {
    if (inSet.has(one.factKeyFp)) continue;
    if (new Set(one.kept.map((kept) => compartmentsOf(kept.claim))).size > 1) {
      out.mixed += 1;
      continue;
    }
    build(ctx, out, one.factKeyFp, one.kept, one.rule, [one.factKeyFp], readable);
  }
  for (const set of sets) buildJoinedSet(ctx, out, set);
  if (factKeys === undefined) return out;
  const asked = new Set(factKeys);
  return {
    ...out,
    rows: out.rows.filter((row) => asked.has(row.factKeyFp) || (row.members ?? []).some((member) => asked.has(member))),
  };
}

// The relations this audience sees that apply as of `asOf`, between two claims this read
// holds. A claim the audience cannot see is not in `inputs`, so no relation naming it
// applies (invariant 6). With them, the stored groupings and those an applied `same_fact` makes.
function appliedRelations(
  inputs: BeliefInputs,
  audience: readonly string[],
  asOf: Timestamp,
): Pick<Build, "applied" | "claimById" | "groupings"> {
  const everyClaim = inputs.groups.flatMap((group) => group.claims);
  const claimById = new Map(everyClaim.map((one) => [one.claim.id as string, one]));
  const keyOfClaim = new Map(
    inputs.groups.flatMap((group) => group.claims.map((one) => [one.claim.id as string, group.factKeyFp] as const)),
  );
  const applied = readRelations(everyClaim, inputs.relations ?? [], inputs.switches ?? [], audience, asOf);
  // An applied `same_fact` between two keys joins them as code's rung 0 grouping does: inside its
  // own label, and never against the owner's split (fact-groups.ts).
  const related: FactGrouping[] = applied.flatMap((relation) => {
    if (relation.kind !== "same_fact") return [];
    return relation.fromIds.flatMap((fromId) =>
      relation.toIds.flatMap((toId) => {
        const [a, b] = [keyOfClaim.get(fromId), keyOfClaim.get(toId)];
        if (a === undefined || b === undefined || a === b) return [];
        const keys = (a < b ? [a, b] : [b, a]) as [string, string];
        return [
          {
            audience: [...new Set(relation.compartments)].sort(),
            keys,
            band: "accept" as const,
            rung: 0 as const,
            state: "accepted" as const,
            calls: [],
          },
        ];
      }),
    );
  });
  const groupings = [...(inputs.groupings ?? []), ...related];
  return { applied, claimById, groupings };
}

// Each fact key's claims as this audience counts them: the owner's kind and domain rulings
// on that key first, then the build's rules.
function prepare(
  groups: BeliefInputs["groups"],
  { audience, asOf, decisions, retirements, readable, applied }: Build,
  reclassifications: FactReclassification[],
  goAt: Timestamp | null,
): Prepared[] {
  const prepared: Prepared[] = [];
  for (const group of groups) {
    // The owner's kind and domain rulings this audience may read, then the rulings made before fact
    // key version 2 that reach a claim by its version 1 key.
    const ruled = reclassify(group.claims, group.factKeyFp, reclassifications, readable).filter(
      (one) => !carriedOut(one, decisions, retirements, goAt, readable),
    );
    const rule = ruled[0] === undefined ? undefined : ruleOf(ruled[0].claim);
    if (rule === undefined) continue;
    // A momentary situation ends a week after it was said, and once ended no longer hides the
    // subject's other situation.
    const current = currentClaims(
      ruled.filter((one) => rule.counts(one) && within(one.claim, audience)),
      asOf,
    );
    // An applied `supersedes` or `refines` within its bounds removes the claim it names; a chain
    // removes each.
    const removed = supersededIn(current, applied, rule.reversalEnds === true);
    const kept = removed.size === 0 ? current : current.filter((one) => !removed.has(one.claim.id));
    if (kept.length > 0) prepared.push({ factKeyFp: group.factKeyFp, kept, rule });
  }
  return prepared;
}

// The sets this audience joins. A set whose keys no longer share one kind and one subject (a
// kind ruling made after the join) is not joined, nor one whose keys no longer share one type
// and one domain as ruled.
function joinPrepared(
  prepared: Prepared[],
  { factRulings, groupings, groupingMode, readable }: Build,
  out: BeliefsFor,
): { sets: Prepared[][]; inSet: Set<string> } {
  const byKey = new Map(prepared.map((one) => [one.factKeyFp, one]));
  const joined = joinedSets([...byKey.keys()], factRulings, groupings, groupingMode, readable);
  out.refused += joined.refused;
  const inSet = new Set<string>();
  const sets: Prepared[][] = [];
  for (const keys of joined.sets) {
    const set = keys.map((key) => byKey.get(key) as Prepared);
    const fact = (one: Prepared): string => {
      const content = one.kept[0]?.claim.content;
      return JSON.stringify([content?.subject, content?.type, content?.fields.domain ?? null]);
    };
    if (set.some((one) => one.rule !== set[0]?.rule || fact(one) !== fact(set[0] as Prepared))) {
      out.refused += 1;
      continue;
    }
    sets.push(set);
    for (const key of keys) inSet.add(key);
  }
  return { sets, inSet };
}

// A joined set builds one belief for each compartment set its claims hold, each under the
// fact key of that part's earliest claim not already taken by an earlier part. A part with no
// key left is counted mixed. Invariant 4: a part's row reads only
// what its own label holds. Its keys are joined again by the joins and grouping rows inside
// that label alone, among the set's keys with a kept claim inside it, so a part splits into
// one row for each such joined set and one for each key left alone; a row's members and group
// are its set's, and only a veto or a retire inside that label closes it. So a row labelled
// `own` is the row the audience of `own` alone builds.
function buildJoinedSet(ctx: Build, out: BeliefsFor, set: Prepared[]): void {
  const { factRulings, groupings, groupingMode } = ctx;
  const keyOf = new Map(
    set.flatMap((one) => one.kept.map((kept) => [kept.claim.id as string, one.factKeyFp] as const)),
  );
  const parts = new Map<string, BeliefClaim[]>();
  for (const kept of set.flatMap((one) => one.kept).sort(earliest))
    parts.set(compartmentsOf(kept.claim), [...(parts.get(compartmentsOf(kept.claim)) ?? []), kept]);
  const taken = new Set<string>();
  for (const part of parts.values()) {
    const label = (part[0] as BeliefClaim).claim.label.compartments;
    const inLabel = (compartments: readonly string[]): boolean => covers(label, compartments);
    const held = set
      .filter((one) => one.kept.some((kept) => inLabel(kept.claim.label.compartments)))
      .map((one) => one.factKeyFp);
    const inner = joinedSets(held, factRulings, groupings, groupingMode, inLabel).sets;
    const setOf = (fp: string): readonly string[] => inner.find((keys) => keys.includes(fp)) ?? [fp];
    const rowsOf = new Map<string, BeliefClaim[]>();
    for (const kept of part) {
      const members = setOf(keyOf.get(kept.claim.id) as string);
      rowsOf.set(members.join("\n"), [...(rowsOf.get(members.join("\n")) ?? []), kept]);
    }
    for (const [joinedKeys, row] of rowsOf) {
      const key = row.map((kept) => keyOf.get(kept.claim.id) as string).find((fp) => !taken.has(fp));
      if (key === undefined) {
        out.mixed += 1;
        continue;
      }
      taken.add(key);
      build(ctx, out, key, row, (set[0] as Prepared).rule, joinedKeys.split("\n"), inLabel);
    }
  }
}

// The provenance of a belief of `kept`: `owner` when any of them is a confirmed proposal's or the
// owner's own command's, else agent_reported when any is a confirmed finding's, else source. The
// store gives an agent record's claim only when the owner confirmed its card.
function provenanceOf(kept: BeliefClaim[]): BeliefRecord["provenance"] {
  const agent = kept.filter((one) => one.origin === "agent_record");
  const commanded = kept.some((one) => one.origin === "owner_command");
  return commanded || agent.some((one) => ABOUT_YOU_PIPELINES.includes(one.claim.pipelineVersion))
    ? "owner"
    : agent.length > 0
      ? "agent_reported"
      : "source";
}

// What closes a belief of `kept` under `factKeyFp`, each as a veto of the key built: the fact
// vetoes of its `members` that `scope` holds, a retire of any member, and an applied `fulfils` of
// a commitment.
function vetoesOf(
  { asOf, decisions, retirements, applied, claimById }: Build,
  factKeyFp: string,
  kept: BeliefClaim[],
  members: readonly string[],
  scope: (compartments: readonly string[]) => boolean,
  settledClaims: Claim[],
): HumanDecision[] {
  const [first] = kept;
  // The fact vetoes of its keys that this audience may read, each as a veto of the key
  // built. A veto in force counts whatever its time: buildBelief leaves out a decision made
  // after `asOf`, and the ruling's time is the admin's clock, which may run ahead of this one.
  const vetoes = decisions
    .filter((decision) => members.includes(decision.targetId) && scope(decision.label.compartments))
    .map((decision) => ({
      ...decision,
      targetId: factKeyFp,
      ...(decision.decidedAt > asOf ? { decidedAt: asOf } : {}),
    }));
  // A retire closes the belief as a veto does, until a claim dated after it that counts, so a
  // later claim `settle` left out reopens nothing.
  for (const member of members) {
    const retired = retiredBy(retirements, member, scope, settledClaims, asOf);
    if (retired === undefined) continue;
    vetoes.push({
      id: retired.id,
      kind: "veto",
      targetKind: "belief",
      targetId: factKeyFp,
      decidedBy: THE_OWNER,
      decidedAt: retired.at > asOf ? asOf : retired.at,
      label: { compartments: retired.compartments, readers: [THE_OWNER] },
    });
  }
  // An applied `fulfils` closes the commitment it names, as of the claim that
  // fulfils it, as a veto on the belief does.
  const keptIds = new Set(kept.map((one) => one.claim.id as string));
  if (first?.claim.content.type === "commitment") {
    for (const relation of applied) {
      if (relation.kind !== "fulfils" || !relation.toIds.some((id) => keptIds.has(id))) continue;
      const by = relation.fromIds
        .map((id) => claimById.get(id))
        .find((one) => one !== undefined && Date.parse(one.claim.validFrom) <= Date.parse(asOf));
      if (by === undefined) continue;
      vetoes.push({
        id: `fulfils:${relation.id}`,
        kind: "veto",
        targetKind: "belief",
        targetId: factKeyFp,
        decidedBy: THE_OWNER,
        decidedAt: by.claim.validFrom,
        label: { compartments: [...relation.compartments], readers: [THE_OWNER] },
      });
    }
  }
  return vetoes;
}

// One belief of `kept`, under `factKeyFp`, added to `out.rows`. `members` are the keys it was
// joined from, or its own key alone: a veto or a retire of any member closes it, one `scope` holds
// every compartment of: the audience's for a key's own belief, the row's label for a joined part.
function build(
  ctx: Build,
  out: BeliefsFor,
  factKeyFp: string,
  kept: BeliefClaim[],
  rule: Rule,
  members: readonly string[],
  scope: (compartments: readonly string[]) => boolean,
): void {
  const { asOf } = ctx;
  const [first] = kept;
  if (first === undefined) return;
  // Its compartments are its claims'.
  const compartments = [...new Set(first.claim.label.compartments)].sort();
  const provenance = provenanceOf(kept);
  // The owner's word, as the store read it, for a rule that lets it supersede; and about the owner,
  // a claim a higher tier outranks is left out, whichever came first.
  const settled = settle(rule, kept);
  const vetoes = vetoesOf(ctx, factKeyFp, kept, members, scope, settled.claims);
  try {
    const lifecycle = lifecycleOf(first.subjectKind);
    // The owner's reopen confirms a commitment, as a claim would, within what this build may see.
    const reopened = ctx.reopens
      .filter((one) => members.includes(one.factKeyFp) && scope(one.compartments) && one.at <= asOf)
      .map((one) => one.at)
      .sort()
      .at(-1);
    const built = buildBelief(settled.claims, vetoes, asOf, PERSONAL_ONTOLOGY, factKeyFp, lifecycle, {
      conflict: settled.conflict,
      reversalEnds: rule.reversalEnds === true,
      ...(reopened === undefined ? {} : { confirmedAt: reopened }),
    });
    if (built === null) return;
    const { belief, settledBy } = withRelations(ctx, built, kept, settled, vetoes, factKeyFp, lifecycle, rule);
    // Its tier, its best kept claim's, from this audience's claims alone. The claim its phrase is
    // read from, among those it was built from (a settled belief's, among the winner's side).
    const losingIds = new Set(settledBy?.losing ?? []);
    const support = new Set<string>(belief.support);
    const phraseClaim = canonicalClaim(kept.filter((one) => support.has(one.claim.id) && !losingIds.has(one.claim.id)));
    const joined = members.length > 1 ? { group: groupOf(members), members: [...members].sort() } : {};
    out.rows.push({
      belief,
      factKeyFp,
      compartments,
      provenance,
      tier: beliefTier(kept),
      ...(phraseClaim === undefined ? {} : { phraseClaim }),
      ...joined,
      ...(settledBy === undefined ? {} : { settled: settledBy }),
      ...(unsupportedFor(belief.support, ctx.claimById, ctx.beliefChecks, ctx.audience, asOf)
        ? { unsupported: true as const }
        : {}),
    });
  } catch {
    out.failed += 1;
  }
}

// An agent's settlement, judged by prevails' bounds as a model's would be.
const AGENT_SETTLES = "agent:settlement";

// The applied relations between two of the built belief's own claims: an applied `contradicts`
// marks an undisputed belief disputed (it can only narrow); the first applied `prevails` within its
// bounds settles a disputed one.
function withRelations(
  { asOf, applied, settlements }: Build,
  built: NonNullable<ReturnType<typeof buildBelief>>,
  kept: BeliefClaim[],
  settled: ReturnType<typeof settle>,
  vetoes: HumanDecision[],
  factKeyFp: string,
  lifecycle: ReturnType<typeof lifecycleOf>,
  rule: Rule,
): { belief: NonNullable<ReturnType<typeof buildBelief>>; settledBy: BeliefRecord["settled"] } {
  let belief = built;
  let settledBy: BeliefRecord["settled"];
  const counted = new Map(kept.map((one) => [one.claim.id as string, one]));
  const both = (relation: Pick<ReadRelation, "fromIds" | "toIds">): [BeliefClaim, BeliefClaim] | undefined => {
    for (const fromId of relation.fromIds)
      for (const toId of relation.toIds) {
        const [from, to] = [counted.get(fromId), counted.get(toId)];
        if (
          from !== undefined &&
          to !== undefined &&
          fromId !== toId &&
          built.support.includes(fromId as never) &&
          built.support.includes(toId as never)
        )
          return [from, to];
      }
    return undefined;
  };
  if (!built.disputed) {
    // An applied `contradicts` between two of its claims marks it disputed: it can only narrow.
    if (applied.some((relation) => relation.kind === "contradicts" && both(relation) !== undefined))
      belief = { ...built, disputed: true };
  } else {
    // An agent's settlement first (it outranks the evidence order), then the
    // first applied `prevails` within its bounds, makes the winner's value the belief's, still
    // disputed, citing every claim; a third value left in dispute settles nothing.
    const settlers: { pair: [BeliefClaim, BeliefClaim]; by: "rule" | "model" | "agent" }[] = [];
    for (const one of settlements) {
      // Within prevails' own bounds: never about the owner, an excluded kind, or a lower tier over a higher.
      const pair = both(one);
      if (pair !== undefined && prevailHolds(pair[0], pair[1], AGENT_SETTLES)) settlers.push({ pair, by: "agent" });
    }
    for (const relation of applied) {
      if (relation.kind !== "prevails") continue;
      const pair = both(relation);
      if (pair === undefined || !prevailHolds(pair[0], pair[1], relation.judge)) continue;
      settlers.push({ pair, by: judgeKindOf(relation.judge) === "model" ? "model" : "rule" });
    }
    for (const { pair, by } of settlers) {
      const [winner, loser] = pair;
      const losing = settled.claims.filter(
        (claim) => stated(claim) === stated(loser.claim) && stated(claim) !== stated(winner.claim),
      );
      const gone = new Set(losing.map((claim) => claim.id as string));
      const won = buildBelief(
        settled.claims.filter((claim) => !gone.has(claim.id)),
        vetoes,
        asOf,
        PERSONAL_ONTOLOGY,
        factKeyFp,
        lifecycle,
        { conflict: settled.conflict, reversalEnds: rule.reversalEnds === true },
      );
      if (won === null || won.disputed || losing.length === 0) continue;
      const sources = new Set(
        settled.claims
          .filter((claim) => stated(claim) === stated(winner.claim))
          .map((claim) => claim.primaryEvidenceId),
      ).size;
      belief = {
        ...won,
        disputed: true,
        support: built.support,
        supportHash: built.supportHash,
        label: built.label,
        lastConfirmedAt: built.lastConfirmedAt,
      };
      settledBy = {
        by,
        winner: winner.claim.id,
        losing: losing
          .map((claim) => claim.id as string)
          .sort()
          .slice(0, 200),
        sources: Math.max(1, sources),
      };
      break;
    }
  }
  return { belief, settledBy };
}

// The belief of each fact key asked, under the caller's clearance, as of `asOf`. The clearance is
// the audience: row-level security already held `inputs` to it, and the build counts no claim and
// no ruling outside it.
export function beliefAt(
  inputs: BeliefInputs,
  clearance: readonly string[],
  factKeys: readonly string[],
  asOf: Timestamp,
): BeliefRecord[] {
  return beliefsFor(inputs, [...clearance].sort(), asOf, factKeys).rows;
}
