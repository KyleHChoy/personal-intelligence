import { READING_STALE_HOURS, type SystemMeasure, type SystemMeasures } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { byText, stamp } from "../../core/db.ts";
import { OUTCOME_THRESHOLDS } from "../../core/outcome-thresholds.ts";
import { unrestrictedOf } from "../admin-time-base.ts";

// The dashboard's System room, as pi_admin: each measure's latest stored reading against its
// healthy line. It reads what the filing pass kept (ledger.measure_readings) and computes nothing:
// `pia outcomes` is the live read. Names, numbers, codes and times only, within the key file's
// compartments but the restricted ones, as the readings are labelled.

// Each measure's latest reading, and when the run of failing readings it ends began: the earliest
// failing reading after its latest reading that was not failing.
const LATEST = `
  select distinct on (m.metric) m.metric, m.state, m.value, m.sample, m.read_at,
    (select min(l.read_at) from ledger.measure_readings l
     where l.metric = m.metric and l.state = 'failing' and l.compartments <@ $1::text[]
       and l.read_at > coalesce((select max(o.read_at) from ledger.measure_readings o
                                 where o.metric = m.metric and o.state <> 'failing' and o.compartments <@ $1::text[]),
                                '-infinity'::timestamptz)) as failing_since
  from ledger.measure_readings m
  where m.compartments <@ $1::text[]
  order by m.metric, m.read_at desc, m.id desc`;

export type MeasureRow = {
  metric: string;
  state: SystemMeasure["state"];
  value: number | null;
  sample: number;
  read_at: Date;
  failing_since: Date | null;
};
type Line = { test: "at_least" | "under" | "at_most"; healthy: number; minSample: number };

const RANK: Readonly<Record<SystemMeasure["state"], number>> = { failing: 0, no_data: 1, ok: 2 };

// Failing first, the longest failing leading, then those with no data, then the healthy, each by name.
export function measuresInOrder(measures: readonly SystemMeasure[]): SystemMeasure[] {
  return [...measures].sort(
    (a, b) =>
      RANK[a.state] - RANK[b.state] || byText(a.failingSince ?? "", b.failingSince ?? "") || byText(a.metric, b.metric),
  );
}

// One stored reading with its measure's healthy line, where it has one, and whether it is still
// current at `now`: the filing pass reads each measure daily, so one older than
// READING_STALE_HOURS says what was.
export function measureOf(row: MeasureRow, now: Date): SystemMeasure {
  const lines: Readonly<Record<string, Line>> = OUTCOME_THRESHOLDS;
  const line = Object.hasOwn(lines, row.metric) ? lines[row.metric] : undefined;
  return {
    metric: row.metric,
    state: row.state,
    value: row.value,
    sample: row.sample,
    readAt: stamp(row.read_at),
    healthy: line === undefined ? null : { test: line.test, value: line.healthy },
    minSample: line === undefined ? null : line.minSample,
    failingSince: row.state === "failing" && row.failing_since !== null ? stamp(row.failing_since) : null,
    stale: now.getTime() - row.read_at.getTime() > READING_STALE_HOURS * 3_600_000,
  };
}

export async function systemMeasures(admin: AdminContext): Promise<SystemMeasures> {
  const rows = await admin.transaction((query) => query<MeasureRow>(LATEST, [unrestrictedOf(admin.keys)]));
  const now = admin.now();
  return { at: stamp(now), measures: measuresInOrder(rows.map((row) => measureOf(row, now))) };
}
