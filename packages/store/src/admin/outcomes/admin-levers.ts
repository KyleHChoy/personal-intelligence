import type { LeverSetting, LeverView } from "@intelligence/contracts/personal";
import { isLeverKey, LEVERS, leverAdmits, leverRefusal } from "@intelligence/personal-core/planner";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type LeverRow, lever, leverViews } from "../../core/settings.ts";

// The owner's side of the levers, as pi_admin: `pia levers`, `pia levers set` and `pia levers
// undo`. The owner may set any registered lever inside its range. Each write goes through one
// definer, which writes the history row as the owner's.

// The list's rows, as policy.levers_read serves them to an agent, with every agent's change `agent`.
const READ = `
  select k.key, s.value,
    case when s.updated_by = 'owner' then 'owner' when s.updated_by is not null then 'agent' end as set_by,
    c.old_value, c.new_value, c.reason, c.at as changed_at,
    case when c.changed_by = 'owner' then 'owner' when c.changed_by is not null then 'agent' end as changed_by
  from (select a.key from policy.settings a union select b.key from policy.setting_changes b) k
  left join policy.settings s on s.key = k.key
  left join lateral (select h.id, h.old_value, h.new_value, h.reason, h.at, h.changed_by from policy.setting_changes h
                     where h.key = k.key order by h.id desc limit 1) c on true
  order by k.key collate "C"`;
const SET = "select policy.owner_set_lever($1::text, $2::jsonb, $3::text, $4::text) as change";
const LAST = "select old_value from policy.setting_changes where key = $1 order by id desc limit 1";

export async function leversView(admin: AdminContext): Promise<{ levers: LeverView[] }> {
  return admin.transaction(async (query) => ({ levers: leverViews(await query<LeverRow>(READ)) }));
}

// The owner's set: any registered lever, inside its range.
export async function setLever(
  admin: AdminContext,
  key: string,
  value: LeverSetting,
): Promise<{ key: string; value: LeverSetting }> {
  const refusal = leverRefusal(key, value, "owner");
  if (refusal !== null || !isLeverKey(key))
    throw new AdminError(refusal === "not_found" ? "not_found" : "invalid_argument");
  return admin.transaction(async (query) => {
    await query(SET, [key, JSON.stringify(value), "owner_set", LEVERS[key].measure]);
    return { key, value: await lever(query, key) };
  });
}

// The owner's undo: back to the value before the last change. With no change recorded, or a value
// the lever no longer admits, the row is removed and the default stands.
export async function undoLever(admin: AdminContext, key: string): Promise<{ key: string; value: LeverSetting }> {
  if (!isLeverKey(key)) throw new AdminError("not_found");
  return admin.transaction(async (query) => {
    const [last] = await query<{ old_value: unknown }>(LAST, [key]);
    const before = last === undefined || !leverAdmits(key, last.old_value) ? null : last.old_value;
    await query(SET, [key, before === null ? null : JSON.stringify(before), "undo", LEVERS[key].measure]);
    return { key, value: await lever(query, key) };
  });
}
