import type { ListLeversResult, SetLeverArgs, SetLeverResult } from "@intelligence/contracts/personal";
import { LEVERS, leverRefusal } from "@intelligence/personal-core/planner";
import { type LeverRow, leverViews } from "../core/settings.ts";
import { answered, type Done, isRefused, refused, type WorkCall } from "../core/work-refs.ts";

// list_levers and set_lever, as pi_reader. The registry is code: the key, the range and who may
// move a lever are checked here, before the one definer that checks the caller holds the tool and
// writes the setting with its history row.

const SQL = {
  read: "select key, value, set_by, old_value, new_value, reason, changed_at, changed_by from policy.levers_read()",
  set: "select set_key, set_value from policy.set_lever($1::text, $2::jsonb, $3::text, $4::text, $5::text, $6::text)",
} as const;

export async function listLevers(call: WorkCall): Promise<Done<ListLeversResult>> {
  const rows = await call.fn<LeverRow>(SQL.read, []);
  if (isRefused(rows)) return refused(rows);
  const levers = leverViews(rows);
  return { outcome: { ok: true, value: { levers } }, rows: levers.length };
}

export async function setLever(call: WorkCall, valid: SetLeverArgs): Promise<Done<SetLeverResult>> {
  const refusal = leverRefusal(valid.key, valid.value, "agent");
  if (refusal !== null) return refused(refusal);
  const rows = await call.fn<{ set_key: string; set_value: number | string }>(SQL.set, [
    valid.key,
    JSON.stringify(valid.value),
    valid.reason,
    LEVERS[valid.key as keyof typeof LEVERS].measure,
    valid.requestId,
    await call.session(),
  ]);
  if (isRefused(rows)) return refused(rows);
  // What stands by this request: a repeat answers what its first call wrote, whatever it names now.
  const [done] = rows;
  return answered({ key: done?.set_key ?? valid.key, value: done?.set_value ?? valid.value });
}
