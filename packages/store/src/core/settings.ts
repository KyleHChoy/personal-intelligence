import type { LeverView } from "@intelligence/contracts/personal";
import { LEVER_KEYS, type LeverKey, leverListing, leverValue } from "@intelligence/personal-core/planner";
import { type Query, stamp } from "./db.ts";

// A lever's value, read: the one way the code reads a tunable
// number. The stored row when the registry admits it, the registry's default otherwise, so a
// database with no rows behaves as the constants did and a bad row never takes effect. A setting
// has no label and holds a number: nothing here is sealed, and nothing is opened.

const READ = "select value, updated_by from policy.settings where key = $1";

// `source`: a transaction's statements, or a read's Ctx.
export async function lever(source: Query | { run: Query }, key: LeverKey): Promise<number> {
  const query = typeof source === "function" ? source : source.run;
  const [row] = await query<{ value: unknown; updated_by: string }>(READ, [key]);
  return leverValue(key, row === undefined ? null : { value: row.value, by: row.updated_by });
}

// A key's stored value and its last change, as policy.levers_read and the owner's read serve them.
// `set_by` and `changed_by` are `owner`, `you` or `agent`, never a client's id.
export type LeverRow = {
  key: string;
  value: unknown;
  set_by: string | null;
  old_value: unknown;
  new_value: unknown;
  reason: string | null;
  changed_at: Date | null;
  changed_by: string | null;
};

const settingOf = (value: unknown): number | null => (typeof value === "number" ? value : null);

// Every registered lever, listed: a stored key the registry does not hold is not served.
export function leverViews(rows: readonly LeverRow[]): LeverView[] {
  const stored = new Map(rows.map((row) => [row.key, row]));
  return LEVER_KEYS.map((key) => {
    const row = stored.get(key);
    const { type, min, max, default: byDefault, mover, undo, measure } = leverListing(key);
    return {
      key,
      type,
      min,
      max,
      // The wire shape's place for a code lever's set: no lever is one.
      allowed: null,
      default: byDefault,
      mover,
      undo,
      measure,
      value: leverValue(key, row === undefined || row.set_by === null ? null : { value: row.value, by: row.set_by }),
      lastChange:
        row === undefined || row.changed_at === null
          ? null
          : {
              at: stamp(row.changed_at),
              by: (row.changed_by ?? "agent") as "owner" | "you" | "agent",
              from: settingOf(row.old_value),
              to: settingOf(row.new_value),
              reason: row.reason ?? "other",
            },
    };
  });
}
