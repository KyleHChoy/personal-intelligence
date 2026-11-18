import { testId } from "./clients.ts";
import { session } from "./connections.ts";
import type { TestDatabase } from "./database.ts";

// The warmth tables' seed rows, one per table, under the compartments given.
export function warmthSeeds(
  db: TestDatabase,
  SEED_AT: string,
): Record<string, (compartments: string[]) => Promise<unknown>> {
  // Written as the day build writes them: as pi_pipeline, or as pi_restricted for a restricted label.
  const asBuilder = (compartments: string[], sql: string, values: unknown[]): Promise<unknown> =>
    session(
      compartments.some((one) => one.startsWith("restricted:")) ? db.urls.restricted : db.urls.pipeline,
      (builder) => builder(sql, values),
    );
  // One person's day under one label, and one label's build row, as the day build writes them.
  const warmthDay = (compartments: string[]) =>
    asBuilder(
      compartments,
      `insert into projections.warmth_days (entity_id, day, compartments, out_w, in_w, meet_w, email_out, email_in, chat_out, chat_in,
         meet_n, started, runs, answered, answer_hours, mutual, theirs) values ($1, date '2026-09-01', $2, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0)`,
      [testId("ent"), [...compartments].sort()],
    );
  const warmthDayBuild = (compartments: string[]) =>
    asBuilder(
      compartments,
      `insert into projections.warmth_day_builds (compartments, built_at, rule_version, time_zone, days) values ($1, $2, 1, 'UTC', 0)
       on conflict (compartments) do update set built_at = excluded.built_at`,
      [[...compartments].sort(), SEED_AT],
    );

  return {
    "projections.warmth_days": warmthDay,
    "projections.warmth_day_builds": warmthDayBuild,
  };
}
