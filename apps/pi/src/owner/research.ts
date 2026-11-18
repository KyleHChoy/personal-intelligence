import { ULID_PATTERN } from "@intelligence/contracts/personal";
import type { CommandContext } from "../command-types.ts";
import { found, refusal } from "../env.ts";
import { print, withAdmin } from "./owner-kit.ts";

// What research landed, and the owner's lift of one fill. Ids, code words and times only; `landed`
// prints to a terminal alone (commands.ts refuses any other stdout).

const RECORD = new RegExp(`^rec_${ULID_PATTERN}$`);

// `pia research landed [--since D]`: each fill since the date (the last 7 days by default), the
// joins first: its record, agent, node, time, state, the fields it filled, what landed of its
// identifier or domain (with a join's ruling, which `pi identity lift` takes) and its claims.
export async function researchLanded(context: CommandContext): Promise<0> {
  const given = context.values.since;
  const since = typeof given === "string" ? new Date(given) : new Date(Date.now() - 7 * 86_400_000);
  if (Number.isNaN(since.getTime())) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    const rows = await admin.research.landed(since);
    for (const row of rows) {
      print(
        context,
        `${row.at} ${row.record} agent:${row.client} ${row.node} ${row.state} fields:${row.fields.join(",") || "-"} ${row.identity}${row.ruling === null ? "" : ` ${row.ruling}`} claims:${row.claims}`,
      );
    }
    print(context, `${rows.length} ${rows.length === 1 ? "fill" : "fills"}`);
  });
}

// `pia research lift REC`: everything one fill wrote goes: its record and claims now, its
// account, domain row and name rows at the next sync.
export async function researchLift(context: CommandContext): Promise<0> {
  const record = context.positionals[0];
  if (record === undefined || !RECORD.test(record)) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    const lifted = found(await admin.research.liftResearch(record));
    print(context, JSON.stringify({ record, ...lifted, effective: "next_sync" }));
  });
}
