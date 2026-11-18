import type { Belief } from "@intelligence/contracts";
import {
  BELIEF_TYPES,
  type BeliefRecord,
  type BeliefTier,
  type PersonalBeliefKind,
  RULABLE_KINDS,
} from "@intelligence/contracts/personal";
import {
  type BeliefInputs,
  beliefAt,
  lifecycleOf,
  PERSONAL_ONTOLOGY,
  rulableKind,
} from "@intelligence/personal-beliefs";
import { canonicalJson, DAY_MS } from "@intelligence/personal-core";
import { readTime } from "../core/answer-time.ts";
import { byText, type Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import type { SupportOf } from "../core/work-time-read.ts";
import { readBeliefInputs, readBeliefInputsUnder } from "../pipeline/belief-inputs.ts";

// Beliefs computed at read under the caller's clearance: every read tool takes its
// beliefs here, never from a stored copy. `beliefAt` builds them from the rows
// policy.belief_inputs returns under the token (a client's), or policy.belief_inputs_under the
// owner's audience (an owner read as pi_admin), as of the reader's clock. Each is given in the form
// a stored row had, so a reader keeps its rules: its id, the fingerprint of what it says, its
// support by stored claim id, its tier, canonical claim and joined set. `updated_at` is the time of
// its newest supporting claim, which orders a list where a stored row's rebuild time did.

// policy.belief_inputs takes at most this many fact keys a call.
const INPUTS_MAX = 1000;

export type ComputedRow = {
  id: string;
  fact_key_fp: string;
  state_fp: string;
  support: string[];
  compartments: string[];
  provenance: BeliefRecord["provenance"];
  tier: BeliefTier;
  phrase_claim: string | null;
  group_fp: string | null;
  updated_at: Date;
  // When what it says last changed, as of the read: a closed belief's latest supporting claim or
  // ruling, an expired one's end (its winning claim's end, else its age's limit), else
  // `updated_at`. get_self's changes are dated by it, as a stored row's rebuild time dated them.
  changed_at: Date;
};
export type Computed = { row: ComputedRow; belief: Belief };

// Who the beliefs are computed for: the token's client, or the owner's audience for a read as
// pi_admin.
export type For = { audience?: readonly string[] | null | undefined };

const CLEARANCE = "select policy.client_clearance() as compartments";

// The fact keys of a belief type among the claims the caller sees, first known by `$2`, newest
// claim first, at most `$4`; with an audience, within it (pi_admin's policies return every row).
// `wanted`: a claim of the key is of a type in `$5`, every type when it is null.
export const BELIEF_KEYS = `
  select c.fact_key_fp, ($5::text[] is null or bool_or(c.type = any ($5::text[]))) as wanted from knowledge.claims c
  where c.type = any ($1::text[]) and c.first_known_at <= $2::timestamptz
    and ($3::text[] is null or c.compartments <@ $3::text[])
  group by c.fact_key_fp
  order by max(c.valid_from) desc, c.fact_key_fp
  limit $4`;

const kindOfType = (type: string): string | undefined => PERSONAL_ONTOLOGY.get(type)?.beliefKind;
// The belief types whose belief may be of one of `kinds`: by the kind of their type, or because the
// owner may rule their fact key to such a kind (belief-rulings.ts rulableKind), which keeps the key.
export const typesOfKinds = (kinds: readonly PersonalBeliefKind[]): string[] =>
  BELIEF_TYPES.filter((type) =>
    [kindOfType(type), ...RULABLE_KINDS.filter((kind) => rulableKind(type, kind)).map(kindOfType)].some(
      (kind) => kind !== undefined && (kinds as readonly string[]).includes(kind),
    ),
  );

// The time a read computes its beliefs as of (core/answer-time.ts): the database transaction's,
// or the clock a test's reader pinned (`ctx.now`). Read once for a call.
const nows = new WeakMap<Ctx, Promise<Date>>();
// The caller's clearance, as policy.belief_inputs derives it from the token.
export const clearanceOf = async (ctx: Ctx): Promise<string[]> =>
  (await ctx.run<{ compartments: string[] }>(CLEARANCE, []))[0]?.compartments ?? [];

// The id a belief of this fact key has for this audience: the rebuild's row id (pipeline-beliefs.ts
// beliefId), the same for every computation of one fact for one clearance. `audience` sorted.
export const beliefIdOf = (keys: Ctx["keys"], factKeyFp: string, audience: readonly string[]): string =>
  `blf_${fingerprint(keys, "fact", [factKeyFp, ...audience].join("\n")).slice(0, 40)}`;

export function asOfOf(ctx: Ctx): Promise<Date> {
  let now = nows.get(ctx);
  if (now === undefined) {
    now = readTime(ctx.run, ctx.now);
    nows.set(ctx, now);
  }
  return now;
}

// The belief of each fact key given (and of each key a joined set joins to one), as of `asOf`,
// each once, under the caller's clearance.
export async function beliefsAt(
  ctx: Ctx,
  factKeys: readonly string[],
  asOf: Date,
  scope: For = {},
): Promise<Computed[]> {
  // No key still reads, so the statements a call sends say nothing of how many keys it holds.
  const keys = [...new Set(factKeys)].sort(byText);
  const audience = scope.audience ?? (await clearanceOf(ctx));
  const sorted = [...new Set(audience)].sort(byText);
  const at = asOf.toISOString();
  const query: Query = (text, values = []) => ctx.run(text, values);
  const built = new Map<string, Computed>();
  for (let start = 0; start === 0 || start < keys.length; start += INPUTS_MAX) {
    const some = keys.slice(start, start + INPUTS_MAX);
    // A stored value that does not open, or does not parse, is `unavailable`, as any read's is.
    const inputs = await (scope.audience == null
      ? readBeliefInputs(query, ctx.keys, some, at)
      : readBeliefInputsUnder(query, ctx.keys, sorted, some, at)
    ).catch((error: unknown) => {
      throw error instanceof Unavailable ? error : new Unavailable();
    });
    const times = timesOf(inputs, asOf);
    for (const record of beliefAt(inputs, sorted, some, at)) {
      if (built.has(record.factKeyFp)) continue;
      built.set(record.factKeyFp, computedOf(ctx, record, sorted, times));
    }
  }
  return [...built.values()];
}

// The times a belief's dates are read from: each claim's start, end and subject's kind, and the
// latest close ruling of each fact key by `asOf`.
type Times = {
  claims: ReadonlyMap<string, { from: number; to: number | undefined; owner: boolean }>;
  ruled: ReadonlyMap<string, number>;
  asOf: number;
};

function timesOf(inputs: BeliefInputs, asOf: Date): Times {
  const claims = new Map(
    inputs.groups.flatMap((group) =>
      group.claims.map(
        (one) =>
          [
            one.claim.id as string,
            {
              from: Date.parse(one.claim.validFrom),
              to: one.claim.validTo === undefined ? undefined : Date.parse(one.claim.validTo),
              owner: one.subjectKind === "owner",
            },
          ] as const,
      ),
    ),
  );
  const ruled = new Map<string, number>();
  const rulings = [
    ...inputs.retirements.map((one) => ({ key: one.factKeyFp, at: Date.parse(one.at) })),
    ...inputs.decisions.map((one) => ({ key: one.targetId, at: Date.parse(one.decidedAt) })),
  ];
  for (const { key, at } of rulings) if (at <= asOf.getTime() && at > (ruled.get(key) ?? 0)) ruled.set(key, at);
  return { claims, ruled, asOf: asOf.getTime() };
}

// When an expired or closed belief changed, by the dates its claims and rulings carry.
function changedAt(record: BeliefRecord, newest: number, times: Times): number {
  const { belief } = record;
  const support = belief.support.flatMap((id) => times.claims.get(id) ?? []);
  if (belief.status === "closed") return Math.max(newest, times.ruled.get(record.factKeyFp) ?? 0);
  if (belief.status !== "expired") return newest;
  const ends = support.flatMap((one) => (one.to !== undefined && one.to <= times.asOf ? [one.to] : []));
  if (ends.length > 0) return Math.max(...ends);
  const rule = lifecycleOf(support.some((one) => one.owner) ? "owner" : undefined)[belief.kind];
  return rule === undefined ? newest : Date.parse(belief.lastConfirmedAt) + rule.endAfterDays * DAY_MS;
}

// A record in a stored row's form: the id the rebuild gave the row of this fact and audience
// (pipeline-beliefs.ts beliefId), and storedBelief's fingerprints.
function computedOf(ctx: Ctx, record: BeliefRecord, audience: readonly string[], times: Times): Computed {
  const claim = (id: string): string => fingerprint(ctx.keys, "claim", id);
  const newest = Math.max(0, ...record.belief.support.map((id) => times.claims.get(id)?.from ?? 0));
  return {
    belief: record.belief,
    row: {
      id: beliefIdOf(ctx.keys, record.factKeyFp, audience),
      fact_key_fp: record.factKeyFp,
      state_fp: fingerprint(ctx.keys, "belief_state", canonicalJson(record.belief)),
      support: record.belief.support.map(claim),
      compartments: record.compartments,
      provenance: record.provenance,
      tier: record.tier ?? "source",
      phrase_claim: record.phraseClaim === undefined ? null : claim(record.phraseClaim),
      group_fp: record.group ?? null,
      updated_at: new Date(newest),
      changed_at: new Date(changedAt(record, newest, times)),
    },
  };
}

// Newest supporting claim first, then by id, as a stored audience's rows were read newest first.
const newestFirst = (list: Computed[]): Computed[] =>
  list.sort((a, b) => b.row.updated_at.getTime() - a.row.updated_at.getTime() || byText(b.row.id, a.row.id));

// The beliefs of the fact keys a statement gives (its rows' `fact_key_fp`), newest first.
export async function keyedBeliefs(
  ctx: Ctx,
  statement: string,
  values: unknown[],
  asOf: Date,
  scope: For = {},
): Promise<Computed[]> {
  const keys = (await ctx.run<{ fact_key_fp: string }>(statement, values)).map((row) => row.fact_key_fp);
  return newestFirst(await beliefsAt(ctx, keys, asOf, scope));
}

// The beliefs the caller's clearance builds as of `asOf`, newest first, from the `most` fact keys
// whose newest claim is newest, and whether keys past them were left (`cut`): the work of a read
// of every belief is bounded, as a stored audience's pages were. With `kinds`, only the keys among
// those `most` whose belief may be of one of them are computed (typesOfKinds): a reader that
// serves those kinds alone is given every belief of them it was given before, and the same `cut`.
export async function everyBelief(
  ctx: Ctx,
  asOf: Date,
  most: number,
  scope: For = {},
  kinds?: readonly PersonalBeliefKind[],
): Promise<{ beliefs: Computed[]; cut: boolean }> {
  const rows = await ctx.run<{ fact_key_fp: string; wanted: boolean }>(BELIEF_KEYS, [
    [...BELIEF_TYPES],
    asOf.toISOString(),
    scope.audience ?? null,
    most + 1,
    kinds === undefined ? null : typesOfKinds(kinds),
  ]);
  const keys = rows.slice(0, most).flatMap((row) => (row.wanted ? [row.fact_key_fp] : []));
  const beliefs = newestFirst(await beliefsAt(ctx, keys, asOf, scope));
  return { beliefs, cut: rows.length > most };
}

// The fact keys of the claims naming any of `$1`, first known by `$2`; with an audience, within it.
export const SUBJECT_KEYS = `
  select distinct c.fact_key_fp from knowledge.claims c
  where c.id in (select n.claim_id from knowledge.claim_entities n where n.entity_id = any ($1::text[]))
    and c.first_known_at <= $2::timestamptz
    and ($3::text[] is null or c.compartments <@ $3::text[])
  order by c.fact_key_fp`;

// Every belief of the fact keys of the claims naming the members (an entity's, as about reads
// them), newest first. A belief they only speak or are a party in is among them.
export const subjectBeliefs = (
  ctx: Ctx,
  members: readonly string[],
  asOf: Date,
  scope: For = {},
): Promise<Computed[]> =>
  keyedBeliefs(ctx, SUBJECT_KEYS, [[...members], asOf.toISOString(), scope.audience ?? null], asOf, scope);

// The supports, by stored claim id, of the beliefs of these fact keys computed under the caller's
// clearance (or the owner's audience): which title links work time counts (work-time-read.ts
// believedLinks).
export const supportsOf =
  (ctx: Ctx, scope: For = {}): SupportOf =>
  async (keys) =>
    (await beliefsAt(ctx, keys, await asOfOf(ctx), scope)).map((one) => one.row.support);
