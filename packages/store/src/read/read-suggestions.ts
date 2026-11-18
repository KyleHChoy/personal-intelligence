import {
  type AgentRecordId,
  DeclineReason,
  GetSuggestionsArgs,
  type GoalProposalId,
  type HypothesisId,
  type OpportunityId,
  type SuggestionList,
} from "@intelligence/contracts/personal";
import { stamp } from "../core/db.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { type Found, shownOnly } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";

// get_suggestions: the caller's own proposals and findings that code settled by the owner's
// earlier answer, each as an `agent_record` item with no results, newest first.
// policy.settled_records is the one definition of which are the caller's and of the label guard
// (invariant 6): an answer under a label the caller cannot see is never told. Requests and
// proposals of intents and watches are not served: their tables do not exist.
const SETTLED = "select record_id, kind, answer, settled_at from policy.settled_records($1, $2)";
// The caller's own work the owner said no to, with the reason they gave, the code of that event:
// an opportunity's no_go (a task's is the owner's cancel) and a hypothesis they rejected on its
// question's card. Read under the reader's policies on every table,
// so a row or an event under a label the caller cannot see is never read (invariant 6); the author
// is the caller, as the definer functions write it. It starts from the owner's no events, so its
// cost is bounded by the owner's noes; only one still the row's latest event is told. And its own
// goal proposals the owner rejected, through policy.declined_goal_proposals, since the reader holds
// no right on ledger.goal_proposals; it applies the same rules.
const DECLINED = `
  with me as (select 'client:' || c.id as author from policy.current_client() c)
  select * from (
    select 'opportunity' as row_kind, o.id, o.kind, o.tier, s.at, s.code from ledger.record_events s
    join ledger.opportunities o on o.id = s.row_id
    where s.row_kind = 'opportunity' and s.event = 'no_go' and s.by = 'owner' and o.created_by = (select author from me) and o.tainted_at is null
      and not exists (select 1 from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id and r.id > s.id)
    union all
    select 'hypothesis', h.id, h.kind, null, s.at, s.code from ledger.record_events s
    join ledger.hypotheses h on h.id = s.row_id
    where s.row_kind = 'hypothesis' and s.event = 'rejected' and s.by = 'owner' and h.created_by = (select author from me) and h.tainted_at is null
      and not exists (select 1 from ledger.record_events r where r.row_kind = 'hypothesis' and r.row_id = h.id and r.id > s.id)
    union all
    select 'goal_proposal', g.id, g.change, null, g.at, g.code from policy.declined_goal_proposals($1) g
  ) x
  order by x.at desc, x.id collate "C" desc limit $1`;
const LISTED = 20;

type Item = SuggestionList["items"][number];
type Settled = { record_id: AgentRecordId; kind: string; answer: "confirmed" | "rejected"; settled_at: Date };
type Declined = {
  row_kind: "opportunity" | "hypothesis" | "goal_proposal";
  id: string;
  kind: string;
  tier: string | null;
  at: Date;
  code: string | null;
};

// What the item is called: a task's no is the owner's cancel, a hypothesis's their reject on its
// question.
const statusOf = (row: Declined): string =>
  row.row_kind !== "opportunity" ? "rejected" : row.tier === "task" ? "cancelled" : "declined";

async function getSuggestions(ctx: Ctx, args: GetSuggestionsArgs): Promise<Found<SuggestionList>> {
  const limit = args.limit ?? LISTED;
  // With no state given, `any`, since every item served is a closed one; `open` lists none, since
  // no open rows are served.
  const state = args.state ?? "any";
  const settled = await ctx.run<Settled>(SETTLED, [state, limit + 1]);
  const declined = state === "open" ? [] : await ctx.run<Declined>(DECLINED, [limit + 1]);
  const items: (Item & { when: number })[] = [
    ...settled.map((row) => ({
      ref: { kind: "agent_record" as const, id: row.record_id },
      what: row.kind,
      status: `settled_${row.answer}`,
      at: stamp(row.settled_at),
      results: [],
      when: row.settled_at.getTime(),
    })),
    ...declined.map((row) => {
      const reason = DeclineReason.safeParse(row.code);
      return {
        ref:
          row.row_kind === "hypothesis"
            ? { kind: "hypothesis" as const, id: row.id as HypothesisId }
            : row.row_kind === "goal_proposal"
              ? { kind: "goal_proposal" as const, id: row.id as GoalProposalId }
              : { kind: "opportunity" as const, id: row.id as OpportunityId },
        what: row.kind,
        status: statusOf(row),
        at: stamp(row.at),
        results: [],
        ...(reason.success ? { reason: reason.data } : {}),
        when: row.at.getTime(),
      };
    }),
  ];
  items.sort((a, b) => b.when - a.when || (a.ref.id < b.ref.id ? 1 : a.ref.id > b.ref.id ? -1 : 0));
  const page = items.slice(0, limit).map(({ when: _when, ...item }) => item);
  // The caller's own rows only: the call shows it nothing it did not write.
  return { value: { items: page, more: items.length > limit }, rows: page.length, read: shownOnly([]) };
}

// The caller's own proposals and findings settled by the owner's earlier answer, view `work`:
// a list tool.
export const GET_SUGGESTIONS_TOOL: ReadTool<GetSuggestionsArgs, SuggestionList> = {
  tool: "get_suggestions",
  parse: (args) => parsed(GetSuggestionsArgs.safeParse(args)),
  work: (ctx, valid) => getSuggestions(ctx, valid),
};
