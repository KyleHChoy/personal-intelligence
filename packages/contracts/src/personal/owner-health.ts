import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { CardId, ClientName, ULID_PATTERN } from "./ids.ts";
import { count, word } from "./owner-fields.ts";

// One thing the owner connected or registered, over the coverage window. `covered`, what should
// flow did; `silent`, something upstream moved and nothing arrived, the one finding; `inactive`,
// connected and nothing happened; `not_read`, an expected gap with its code (`switched_off`,
// `not_admitted`). Ids, counts and codes only: never a name, subject, title or host. A row's id is
// a row id, a word (a lane or a job), or a device's id and a capture class.
export const CoverageState = z.enum(["covered", "silent", "inactive", "not_read"]);
export type CoverageState = z.infer<typeof CoverageState>;
export const CoverageRow = z.strictObject({
  kind: z.enum(["account", "device", "capture_class", "lane", "job", "client"]),
  id: z.string().regex(new RegExp(`^(?:[a-z]{3}_${ULID_PATTERN}(?::[a-z][a-z0-9_]{0,31})?|[a-z][a-z0-9_]{0,31})$`)),
  state: CoverageState,
  code: word.optional(),
  counts: z.record(word, count),
});
export type CoverageRow = z.infer<typeof CoverageRow>;

// What one box health card is about. `silent`, a coverage row that entered `silent` (`about` is `<kind>/<id>`); `hold`, a hold left on more than an hour (sync_hold, read_hold or
// wake_off), or the box waiting for the owner's migration (migrate_wait, raised as it starts); `timed_out`, a job its time limit stopped; `failure_streak`, a job whose last three
// runs failed; `backup_due`, a dump or its restore test due (`backup`, `restore`); `restarting`, a supervised process that keeps ending within a minute of its start;
// `dashboard_down`, the owner's page off their tailnet for 15 minutes; `stores_nothing`, an account whose syncs end ok and store no item (`account/<id>`); `budget_stops`, a job that
// keeps stopping on its budget; `extract_backlog`, many items extraction failed on; `detector_stopped`, a daily job with no run for three days; `token_expiring`, a client's own
// token that lapses within seven days (`client/<id>`); `tls_unverified`, the box's connection to a database on another host checking no certificate (`database`).
export const BOX_HEALTH_KINDS = [
  "silent",
  "hold",
  "timed_out",
  "failure_streak",
  "backup_due",
  "restarting",
  "dashboard_down",
  "stores_nothing",
  "budget_stops",
  "extract_backlog",
  "detector_stopped",
  "key_changed",
  "token_expiring",
  "tls_unverified",
] as const;
export const BoxHealthKind = z.enum(BOX_HEALTH_KINDS);
export type BoxHealthKind = z.infer<typeof BoxHealthKind>;
// The kinds an agent may mark seen: each is checked again by code and raised again while what it
// told of still holds, so an agent's seen hides nothing for good. The others ask for what only the
// owner can do (lift a hold, take a dump or a restore test, accept a key change, mend a process or
// the page on their tailnet), and the box raises none of them again while it stands: they are the
// owner's to mark.
export const AGENT_SEEN_KINDS = [
  "silent",
  "timed_out",
  "failure_streak",
  "stores_nothing",
  "budget_stops",
  "extract_backlog",
  "detector_stopped",
] as const satisfies readonly BoxHealthKind[];
export const isAgentSeenKind = (kind: string): boolean => (AGENT_SEEN_KINDS as readonly string[]).includes(kind);
// The jobs ledger.job_runs records.
export const JOB_NAMES = [
  "sync",
  "erase_settle",
  "work_tick",
  "extract",
  "dream",
  "reasoner",
  "outcome_test",
  "improvement_filing",
  "backup",
  // A restore drill (`pi restore check`): `ok` for a whole, current copy, `failed`, or `schema_behind`
  // for a dump older than the newest migration, which tested nothing.
  "restore_drill",
  "canary",
] as const;
export const JobName = z.enum(JOB_NAMES);
export type JobName = z.infer<typeof JobName>;
export const HOLD_NAMES = ["sync_hold", "read_hold", "wake_off", "migrate_wait"] as const;
export const HoldName = z.enum(HOLD_NAMES);
export type HoldName = z.infer<typeof HoldName>;
// The box's supervised processes, by lib/supervise's name for each.
export const SUPERVISED_NAMES = ["http", "wake", "notify", "web", "tailscaled"] as const;
export const SupervisedName = z.enum(SUPERVISED_NAMES);
export type SupervisedName = z.infer<typeof SupervisedName>;
// What a box health card is about: a word, or a coverage row's `<kind>/<id>`.
export const BoxHealthAbout = z
  .string()
  .regex(
    new RegExp(
      String.raw`^[a-z][a-z0-9_]{0,31}(?:\/(?:[a-z]{3}_${ULID_PATTERN}(?::[a-z][a-z0-9_]{0,31})?|[a-z][a-z0-9_]{0,31}))?$`,
    ),
  );
export type BoxHealthAbout = z.infer<typeof BoxHealthAbout>;
// One open box health card, as `pia status` and the dashboard's Settings health show it.
export const BoxHealthRow = z.strictObject({
  card: CardId,
  kind: BoxHealthKind,
  about: BoxHealthAbout,
  code: word.nullable(),
  at: Timestamp,
});
export type BoxHealthRow = z.infer<typeof BoxHealthRow>;
// A box health card an agent marked seen, as `pia status` and the System room show it: the card,
// what it was about, the agent by its name and when.
export const BOX_HEALTH_SEEN_DAYS = 7;
export const BOX_HEALTH_SEEN_MOST = 20;
export const BoxHealthSeenRow = z.strictObject({
  card: CardId,
  kind: BoxHealthKind,
  about: BoxHealthAbout,
  client: ClientName,
  at: Timestamp,
});
export type BoxHealthSeenRow = z.infer<typeof BoxHealthSeenRow>;
