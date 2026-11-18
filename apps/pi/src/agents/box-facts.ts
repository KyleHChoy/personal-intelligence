import { existsSync } from "node:fs";
import type { BoxFacts } from "@intelligence/personal-store";
import { deployedCommit } from "../deployed-commit.ts";

// What the agent API's own process can see of the box, for get_health's `box`: the hold files the
// timer obeys, the box's wait for the owner's migration (lib/migrate-start), the one switch that is
// a file on the volume, and the commit of this image. Each is a file's presence or a constant: a code, the same for every caller, and nothing of any source. The
// switches that are environment files of other Unix users (the tester's) cannot be
// read from here and are not served: a job a switch keeps off shows as `lane_off` among the jobs.
const HOLDS = {
  sync_hold: "/data/sync-hold",
  read_hold: "/data/read-hold",
  wake_off: "/data/wake-off",
  dream_hold: "/data/dream-hold",
  migrate_wait: "/data/migrate-wait",
} as const;
const EXTRACT_ON = "/data/extract-on";
// Every flag file on the volume get_health's `box` reads: the holds and the one switch.
export const BOX_FLAG_FILES: readonly string[] = [...Object.values(HOLDS), EXTRACT_ON];

export function boxFacts(exists: (path: string) => boolean = existsSync): BoxFacts {
  return {
    holds: Object.entries(HOLDS)
      .filter(([, path]) => exists(path))
      .map(([name]) => name),
    switches: [{ key: "extract_on", value: exists(EXTRACT_ON) ? "on" : "off" }],
    commit: deployedCommit(),
  };
}

// What `pia status` says of the box's holds: each by its code and, while the box waits for the
// owner's migration (lib/migrate-start made /data/migrate-wait and `pi-migrate` has not yet
// succeeded), that in one word of its own, so the reason nothing syncs or answers is not left to a
// code among the holds.
export function statusBox(holds: readonly string[] = boxFacts().holds): { holds: string[]; waiting?: "migration" } {
  return { holds: [...holds], ...(holds.includes("migrate_wait") ? { waiting: "migration" as const } : {}) };
}
