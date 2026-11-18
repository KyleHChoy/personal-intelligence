import type { Timestamp } from "@intelligence/contracts";
import { CANARY_CLIENT_PREFIX } from "@intelligence/contracts/personal";
import { byText, type Query, stamp } from "../../core/db.ts";
import { refusalRateOf, type UsageState, usageStateOf } from "../../core/outcome-thresholds.ts";

// What `pi outcomes` says of the tools: each tool's calls and refusals, and why calls were refused,
// by tool, reason and field. Counts and fixed codes alone (policy.log_call), with the standing check's
// own clients left out.

// A tool is used when someone real used it: the standing check's own calls are no use.
const NOT_THE_CHECK = `client_id not in (select k.id from policy.clients k where starts_with(k.name, '${CANARY_CLIENT_PREFIX}'))`;

export type ToolUsage = {
  tool: string;
  calls: number;
  successes: number;
  refusals: Record<string, number>;
  refusalRate: number | null;
  lastUsedAt: Timestamp | null;
  state: UsageState;
};
// A refused call's reason and field: null on a row from before the log kept them, and on a code that
// has none of its own to give, such as a not_found.
export type RefusedField = {
  tool: string;
  outcome: string;
  reason: string | null;
  field: string | null;
  calls: number;
};
type Clock = { now: Date; ago: (days: number) => Timestamp };

export async function toolUsage(query: Query, days: number, { now, ago }: Clock): Promise<ToolUsage[]> {
  const window = [ago(days), stamp(now)];
  const counts = await query<{ tool: string; outcome: string; n: number }>(
    `select tool, outcome, count(*)::int as n from policy.calls where at >= $1 and at <= $2 and ${NOT_THE_CHECK} group by tool, outcome`,
    window,
  );
  const last = await query<{ tool: string; at: Date }>(
    `select tool, max(at) as at from policy.calls where at <= $1 and ${NOT_THE_CHECK} group by tool`,
    [stamp(now)],
  );
  const names = await query<{ name: string }>("select name from policy.tool_names");
  const lastOf = new Map(last.map((row) => [row.tool, row.at]));
  return names
    .map(({ name }) => name)
    .sort(byText)
    .map((tool) => {
      const own = counts.filter((row) => row.tool === tool);
      const refused = own.filter((row) => row.outcome !== "ok").sort((a, b) => byText(a.outcome, b.outcome));
      const calls = own.reduce((sum, row) => sum + row.n, 0);
      const refusedCalls = refused.reduce((sum, row) => sum + row.n, 0);
      const lastUsed = lastOf.get(tool);
      return {
        tool,
        calls,
        successes: calls - refusedCalls,
        refusals: Object.fromEntries(refused.map((row) => [row.outcome, row.n])),
        refusalRate: refusalRateOf(refusedCalls, calls),
        lastUsedAt: lastUsed === undefined ? null : stamp(lastUsed),
        state: usageStateOf(calls),
      };
    });
}

// The window's refusals by what was wrong, most first.
export async function refusedFields(query: Query, days: number, { now, ago }: Clock): Promise<RefusedField[]> {
  return query<RefusedField>(
    `select tool, outcome, reason, field, count(*)::int as calls from policy.calls
     where at >= $1 and at <= $2 and outcome <> 'ok' and ${NOT_THE_CHECK}
     group by tool, outcome, reason, field
     order by calls desc, tool, outcome, reason nulls last, field nulls last`,
    [ago(days), stamp(now)],
  );
}
