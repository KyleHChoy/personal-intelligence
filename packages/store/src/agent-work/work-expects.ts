import type {
  ExpectedOutcome,
  OpportunityKind,
  OutcomeRules,
  OutcomeType,
  SubjectRef,
  WatchRef,
} from "@intelligence/contracts/personal";
import { outcomeRules } from "../core/outcome-rules.ts";
import { sealSummary } from "../core/work-refs.ts";
import { resolveSubject } from "../read/read-about.ts";
import type { Ctx } from "../read/read-ctx.ts";
import { loadGroups } from "../read/read-groups.ts";

// What a proposal expects and what a move watches, built by code before the work tools' definers
// run. An expectation is the agent's, checked against
// its type by the contract (ExpectedOutcome), or the kind's default from `ontology/outcomes.json`;
// its subject is resolved within the caller's clearance as `about` resolves one, and its values are
// sealed under the caller's clearance, the opportunity's label. ledger.set_expectations writes them
// and ledger.add_watches the watches, each only on work the call itself wrote or moved.

// One expectation before its subject is resolved and its values sealed: null subject, the work's own.
export type Expectation = {
  subject: SubjectRef | null;
  type: OutcomeType;
  success: Record<string, unknown>;
  failure: Record<string, unknown> | null;
  horizonDays: number;
  origin: "stated" | "default";
};

// The agent's expectations, else the kind's default, else none. A kind the file gives no default
// (introduction) has none.
const defaultOf = (table: OutcomeRules, kind: OpportunityKind) =>
  kind === "introduction" ? null : table.defaults[kind];

export function expectationsOf(
  kind: OpportunityKind,
  expects: readonly ExpectedOutcome[] | undefined,
  table: OutcomeRules = outcomeRules(),
): Expectation[] {
  if (expects !== undefined) {
    return expects.map((one) => ({
      subject: one.subject ?? null,
      type: one.type,
      success: one.success,
      failure: one.failure ?? null,
      horizonDays: one.horizonDays ?? defaultOf(table, kind)?.horizonDays ?? table.horizonDays,
      origin: "stated",
    }));
  }
  const fallback = defaultOf(table, kind);
  return fallback === null
    ? []
    : [
        {
          subject: null,
          type: fallback.type,
          success: {},
          failure: null,
          horizonDays: fallback.horizonDays,
          origin: "default",
        },
      ];
}

// What ledger.set_expectations takes: each subject an entity id or null, each value sealed (none
// when it has no field), bound to `<opportunity>/<ordinal>`.
export type BuiltExpectation = {
  subject: string | null;
  type: OutcomeType;
  success: unknown;
  failure: unknown;
  horizonDays: number;
  origin: "stated" | "default";
};

const sealed = (
  ctx: Ctx,
  clearance: readonly string[],
  opportunity: string,
  ordinal: number,
  column: string,
  fields: Record<string, unknown> | null,
): unknown =>
  fields === null || Object.keys(fields).length === 0
    ? null
    : JSON.parse(
        sealSummary(
          ctx,
          clearance,
          { table: "ledger.expected_outcomes", id: `${opportunity}/${ordinal}`, column },
          JSON.stringify(fields),
        ),
      );

// Each subject resolved within the caller's clearance: unknown is not_found, several people of one
// name invalid_request, as a ref the caller cannot see and an ambiguous one are answered elsewhere.
export async function buildExpectations(
  ctx: Ctx,
  clearance: readonly string[],
  opportunity: string,
  list: readonly Expectation[],
): Promise<BuiltExpectation[] | "not_found" | "invalid_request"> {
  const groups = list.some((one) => one.subject !== null) ? await loadGroups(ctx) : null;
  const built: BuiltExpectation[] = [];
  for (const [ordinal, one] of list.entries()) {
    let subject: string | null = null;
    if (one.subject !== null && groups !== null) {
      const resolved = await resolveSubject(ctx, groups, one.subject);
      if (resolved.kind === "unknown") return "not_found";
      if (resolved.kind === "candidates") return "invalid_request";
      subject = resolved.id;
    }
    built.push({
      subject,
      type: one.type,
      success: sealed(ctx, clearance, opportunity, ordinal, "success_enc", one.success),
      failure: sealed(ctx, clearance, opportunity, ordinal, "failure_enc", one.failure),
      horizonDays: one.horizonDays,
      origin: one.origin,
    });
  }
  return built;
}

// The messages and entities a move's `watch` names that the caller's token returns: every one, or
// the call is not_found before the move, as a ref in a basis is.
const SEEN = `
  select 'message' as kind, m.id from knowledge.messages m where m.id = any ($1::text[])
  union all
  select 'entity', e.id from knowledge.entities e where e.id = any ($2::text[])`;
export async function watchSeen(ctx: Ctx, watch: readonly WatchRef[]): Promise<boolean> {
  const of = (kind: WatchRef["kind"]) => [
    ...new Set(watch.filter((ref) => ref.kind === kind).map((ref) => ref.id as string)),
  ];
  const seen = await ctx.run<{ kind: string; id: string }>(SEEN, [of("message"), of("entity")]);
  return seen.length === of("message").length + of("entity").length;
}
