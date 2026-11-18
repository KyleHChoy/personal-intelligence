import type { ThresholdGrant } from "@intelligence/contracts/personal";
import type { Query } from "./db.ts";

// The latest unrevoked grant of each point, version and name: what a run applies (the pipeline
// reads the same) and what `pi thresholds list` shows.
export async function latestGrants(query: Query): Promise<ThresholdGrant[]> {
  const rows = await query<{
    id: string;
    point: string;
    version: number;
    name: string;
    value: string;
    source: "proposal" | "set";
  }>(
    `select distinct on (point, version, name) id, point, version, name, value::text as value, source from policy.thresholds
     where revoked_at is null order by point, version, name, granted_at desc, id collate "C" desc`,
  );
  return rows.map((row) => ({ ...row, value: Number(row.value) }));
}
