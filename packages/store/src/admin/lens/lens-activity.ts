import { type ActivityDay, canonicalTimeZone, dayAfter, dayIn } from "@intelligence/contracts/personal";
import { activityDay, activityTable, type CaptureFacts } from "@intelligence/personal-core/lens";
import type { AdminContext } from "../../core/admin-context.ts";
import { type LabelRow, parsedOrNull } from "./lens-admin.ts";

// `pi lens time`, the owner's time by activity category for each local day of a range, as pi_admin:
// every stored block day of the range, but a restricted one, its blocks opened from their sealed
// facts and put in categories by the repository's table, code alone. The view is computed each time
// it is read and never stored. It shows categories, minutes and the table's version: no app, host,
// title or path. A day with no block is left out. With no `to`, the range ends on today in the
// owner's zone (`pi owner timezone`, UTC while unset), by the admin's clock; with no `from`, it is
// the seven days to `to`.
export async function activity(admin: AdminContext, given: { from?: string; to?: string }): Promise<ActivityDay[]> {
  const table = activityTable();
  return admin.transaction(async (query) => {
    const [setting] = await query<{ time_zone: string | null }>("select time_zone from policy.owner_settings");
    const zone = setting?.time_zone == null ? null : canonicalTimeZone(setting.time_zone);
    const to = given.to ?? dayIn(admin.now(), zone);
    const range = { from: given.from ?? dayAfter(to, -6), to };
    const rows = await query<LabelRow & { day: string }>(
      `select '' as label, id, compartments, facts_enc as value_enc, local_day::text as day
       from knowledge.captures
       where kind = 'block' and local_day between $1::date and $2::date and not policy.is_restricted(compartments)
       order by local_day, id collate "C"`,
      [range.from, range.to],
    );
    const days = new Map<string, Extract<CaptureFacts, { kind: "block" }>["blocks"]>();
    for (const row of rows) {
      const facts = parsedOrNull(admin.keys, "knowledge.captures", "facts_enc", row) as CaptureFacts | null;
      if (facts?.kind !== "block") continue;
      days.set(row.day, [...(days.get(row.day) ?? []), ...facts.blocks]);
    }
    return [...days.entries()].map(([day, blocks]) => activityDay(day, blocks, table));
  });
}
