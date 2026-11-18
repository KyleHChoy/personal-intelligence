import { type Belief, BeliefStatus } from "@intelligence/contracts";
import type { ClaimRecord, CompiledBelief, FactView, SubjectKind } from "@intelligence/contracts/personal";
import type { Ctx } from "../core/read-ctx.ts";
import { parseOr } from "../core/served.ts";
import type { Computed } from "../read/computed-beliefs.ts";
import { OWNER_ENTITY } from "../read/read-beliefs.ts";
import { compiled, keptProjectWhos, noClaims, type Order, subjectKindsOf } from "../read/read-compiled.ts";
import { type FactRow, PROJECTS_NAMED } from "../read/read-fact-rows.ts";
import { factViewer, projectWhos } from "../read/read-facts.ts";

// Lens's mirror: find_facts' and get_beliefs' builders, kept to what the
// mirror's template carries, as the owner's Mac reads them.

// find_facts' FactView of each row, as factsOf builds its page: the projects the claims name, the
// viewer, and the status of the caller's audience's belief on a claim in its support. A belief of a
// kind the chosen version does not list gives no status, as if the client could not see it.
export async function mirrorFactViews(ctx: Ctx, page: FactRow[], beliefKinds: readonly string[]): Promise<FactView[]> {
  if (page.length === 0) return [];
  const projects = await projectWhos(
    ctx,
    PROJECTS_NAMED,
    page.map((row) => row.id),
  );
  const { records, view, beliefs } = await factViewer(ctx, page, { given: projects });
  return page.map((row, index): FactView => {
    const belief = beliefs.get(row.fact_key_fp);
    const opened = belief?.row.support.includes(row.id) === true ? belief.belief : undefined;
    const status =
      opened !== undefined && beliefKinds.includes(opened.kind)
        ? parseOr(BeliefStatus.safeParse(opened.status))
        : undefined;
    return unTiered(view(row, records[index] as ClaimRecord, status));
  });
}

// lens_mirror@1 carries no tier, no channel, no source and no joined belief's group; a later template
// version may. The mirror's entries stay as they were, so no stamp moves.
function unTiered<T extends object>(one: T): T {
  const {
    tier: _tier,
    channel: _channel,
    group: _group,
    sourceMark: _sourceMark,
    source: _source,
    ...rest
  } = one as T & { tier?: unknown; channel?: unknown; group?: unknown; sourceMark?: unknown; source?: unknown };
  return rest as T;
}

// get_beliefs' CompiledBelief of each row `keep` keeps, by the row's id: opened, kept by its kind
// and its subject's kind, and compiled with its citing claims as beliefsOf compiles them. A belief
// compiled() leaves out (none of its claims returned, or naming an entity the token does not show)
// is not in the map, nor is one whose subject the token does not show.
export async function mirrorBeliefs(
  ctx: Ctx,
  rows: readonly Computed[],
  keep: (belief: Belief, subjectKind: SubjectKind) => boolean,
): Promise<Map<string, CompiledBelief>> {
  if (rows.length === 0) return new Map();
  // lens_mirror@1 reads no tier, canonical claim or joined set of a belief.
  const opened = rows.map(({ row, belief }) => {
    const {
      tier: _tier,
      phrase_claim: _phrase,
      group_fp: _group,
      updated_at: _updated,
      changed_at: _changed,
      ...kept
    } = row;
    return { row: kept, belief };
  });
  const kindOf = await subjectKindsOf(
    ctx,
    opened.map((one) => one.belief.subject),
  );
  const kept = opened.filter((one) => {
    const kind = kindOf.get(one.belief.subject);
    return kind !== undefined && keep(one.belief, kind);
  });
  if (kept.length === 0) return new Map();
  const [owner] = await ctx.run<{ id: string }>(OWNER_ENTITY, []);
  const supportIds = [...new Set(kept.flatMap((one) => one.row.support))];
  const projects = await keptProjectWhos(ctx, kindOf, kept);
  const order: Order = (cited, _claims, more) => ({ beliefs: cited, claims: [], more });
  const { facts } = await compiled(ctx, {
    subject: null,
    members: [],
    kept,
    supportIds,
    aboutRows: noClaims,
    cut: false,
    order,
    ownerId: owner?.id,
    projects,
  });
  const idOf = new Map(kept.map((one) => [one.row.fact_key_fp, one.row.id]));
  return new Map(
    facts.beliefs.flatMap((belief) => {
      const id = idOf.get(belief.fact);
      return id === undefined
        ? []
        : [[id, { ...unTiered(belief), cites: belief.cites.map(unTiered) } as CompiledBelief] as const];
    }),
  );
}
