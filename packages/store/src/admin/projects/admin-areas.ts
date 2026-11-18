import { AreaKey, type EntityId, PROJECT_NAME_MOST, RoleName } from "@intelligence/contracts/personal";
import { codePoints } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { byText, type Query, stamp } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import { lockRows } from "../../core/queue.ts";
import type { Sealed } from "../../core/seal.ts";
import { openUnder, sealUnder } from "../../core/seal.ts";
import { PROJECT_AREA, recordEvent } from "../record-event.ts";

// The owner's area commands, as pi_admin. An area is a standing part of the owner's life or work
// that projects belong to: a key the owner chooses, a name in the owner's words sealed under the
// area's label, a place in the owner's order and a state. Only the owner adds, renames, orders or
// retires one (AR2), and the owner's area on a project stands against any agent's (AR5). Every
// area's label is the owner's own compartment (AR3), which the table's check holds. No command here
// writes an owner decision: the area's row and the project's `area` event are the record.

// An area's whole label.
const LABEL: string[] = ["own"];
const nameAt = (id: string) => ({ table: "knowledge.areas", id, column: "name_enc" });

type AreaRow = { id: string; key: string; state: "active" | "retired"; position: number };
export type OwnerAreaView = {
  key: string;
  // Null where the key file does not open it.
  name: string | null;
  retired: boolean;
  // The roles whose default area this is.
  defaultFor: string[];
  projects: number;
};

function checkedName(name: string): string {
  if (codePoints(name.trim()) === 0 || codePoints(name) > PROJECT_NAME_MOST || name.includes("\u0000"))
    throw new AdminError("invalid_argument");
  return name.trim();
}

function checkedKey(key: string): string {
  if (!AreaKey.safeParse(key).success) throw new AdminError("invalid_argument");
  return key;
}

// Every area, locked, in the owner's order: one owner command at a time changes the areas.
const locked = (query: Query): Promise<AreaRow[]> =>
  query<AreaRow>('select id, key, state, position from knowledge.areas order by position, key collate "C" for update');

// `pi areas add KEY`: a new active area, last in the order. duplicate_name for a key in use, a
// retired area's included: a key is never given twice.
export async function add(admin: AdminContext, key: string, name: string): Promise<void> {
  checkedKey(key);
  const sealedName = checkedName(name);
  const now = admin.now();
  await admin.transaction(async (query) => {
    const areas = await locked(query);
    if (areas.some((one) => one.key === key)) throw new AdminError("duplicate_name");
    const id = newId("are");
    await query(
      "insert into knowledge.areas (id, key, name_enc, position, state, created_at, updated_at, compartments) values ($1, $2, $3, $4, 'active', $5, $5, $6)",
      [
        id,
        key,
        sealUnder(admin.keys, LABEL, nameAt(id), sealedName),
        Math.max(0, ...areas.map((one) => one.position)) + 1,
        stamp(now),
        LABEL,
      ],
    );
  });
}

// `pi areas rename KEY`: the owner's new name for it; its key stays. not_found for no such key.
export async function rename(admin: AdminContext, key: string, name: string): Promise<void> {
  const sealedName = checkedName(name);
  const now = admin.now();
  await admin.transaction(async (query) => {
    const area = (await locked(query)).find((one) => one.key === key);
    if (area === undefined) throw new AdminError("not_found");
    await query("update knowledge.areas set name_enc = $2, updated_at = $3 where id = $1", [
      area.id,
      sealUnder(admin.keys, LABEL, nameAt(area.id), sealedName),
      stamp(now),
    ]);
  });
}

// The areas in a new order: the keys named first, as named, then the rest as they stood. A pure
// rule: null for a key named twice or one that is no area.
export function reordered(present: readonly string[], named: readonly string[]): string[] | null {
  if (new Set(named).size !== named.length || named.some((key) => !present.includes(key))) return null;
  return [...named, ...present.filter((key) => !named.includes(key))];
}

// `pi areas order KEY...`: the owner's order. invalid_argument for a key named twice, not_found
// for one that is no area.
export async function order(admin: AdminContext, keys: readonly string[]): Promise<void> {
  if (keys.length === 0 || new Set(keys).size !== keys.length) throw new AdminError("invalid_argument");
  const now = admin.now();
  await admin.transaction(async (query) => {
    const areas = await locked(query);
    const next = reordered(
      areas.map((one) => one.key),
      keys,
    );
    if (next === null) throw new AdminError("not_found");
    for (const [index, key] of next.entries()) {
      const area = areas.find((one) => one.key === key);
      if (area === undefined || area.position === index + 1) continue;
      await query("update knowledge.areas set position = $2, updated_at = $3 where id = $1", [
        area.id,
        index + 1,
        stamp(now),
      ]);
    }
  });
}

// `pi areas retire KEY`: the area takes no new project and keeps the ones it has, which read as in
// it, marked retired (AR4). A role's default that names it gives none from then on. not_found for
// no such key; one already retired stays so.
export async function retire(admin: AdminContext, key: string): Promise<void> {
  const now = admin.now();
  await admin.transaction(async (query) => {
    const area = (await locked(query)).find((one) => one.key === key);
    if (area === undefined) throw new AdminError("not_found");
    if (area.state === "retired") return;
    await query("update knowledge.areas set state = 'retired', updated_at = $2 where id = $1", [area.id, stamp(now)]);
  });
}

// `pi areas list`: every area in the owner's order, its name opened, the roles it is the default
// of and how many projects it holds.
export async function list(admin: AdminContext): Promise<OwnerAreaView[]> {
  const { rows, defaults } = await admin.transaction(async (query) => ({
    rows: await query<AreaRow & { name_enc: Sealed; compartments: string[]; projects: number }>(
      `select a.id, a.key, a.state, a.position, a.name_enc, a.compartments,
         (select count(*)::integer from knowledge.projects p where p.area_id = a.id and p.status <> 'merged') as projects
       from knowledge.areas a order by (a.state = 'retired'), a.position, a.key collate "C"`,
    ),
    defaults: (
      await query<{ area_defaults: Record<string, string> }>("select area_defaults from policy.work_settings")
    )[0]?.area_defaults,
  }));
  return rows.map((row) => {
    let name: string | null;
    try {
      name = openUnder(admin.keys, row.compartments, nameAt(row.id), row.name_enc);
    } catch {
      name = null;
    }
    return {
      key: row.key,
      name,
      retired: row.state === "retired",
      defaultFor: Object.entries(defaults ?? {})
        .flatMap(([role, area]) => (area === row.id ? [role] : []))
        .sort(),
      projects: row.projects,
    };
  });
}

// `pi areas default ROLE KEY | --none` (AR6): the area a project takes when an agent holding the
// role creates it and names none. unknown_role for a role no active agent holds, not_found for a
// key that is no active area.
export async function setDefault(admin: AdminContext, role: string, key: string | null): Promise<void> {
  if (!RoleName.safeParse(role).success) throw new AdminError("invalid_argument");
  await admin.transaction(async (query) => {
    await query("select 1 from policy.work_settings for update");
    if (key === null) {
      await query("update policy.work_settings set area_defaults = area_defaults - $1::text", [role]);
      return;
    }
    const held = await query(
      "select 1 from policy.clients where status = 'active' and kind = 'agent' and $1 = any (roles)",
      [role],
    );
    if (held.length === 0) throw new AdminError("unknown_role");
    const area = (await locked(query)).find((one) => one.key === key);
    if (area === undefined || area.state !== "active") throw new AdminError("not_found");
    await query(
      "update policy.work_settings set area_defaults = area_defaults || jsonb_build_object($1::text, $2::text)",
      [role, area.id],
    );
  });
}

// `pi project area PROJECT KEY | --none` (AR5): the owner's word on a project's area, which an
// agent's update_project leaves standing. The event is written under the project's label joined
// with the area's, so a reader of the project that cannot see areas is returned no such event, and
// the project's time of change moves only when every reader of the project can see areas: when its
// own label holds the area's (invariant 6). not_found for a project that is not there or was
// merged, or a key that is no active area; the owner's same word again writes nothing.
export async function setProjectArea(admin: AdminContext, project: EntityId, key: string | null): Promise<void> {
  const now = admin.now();
  await admin.transaction(async (query) => {
    // As ledger.update_project locks it, so the owner's word and an agent's never interleave.
    await lockRows(query, [project]);
    const [row] = await query<{ status: string; compartments: string[]; area_id: string | null }>(
      "select status, compartments, area_id from knowledge.projects where id = $1 for update",
      [project],
    );
    if (row === undefined || row.status === "merged") throw new AdminError("not_found");
    const area = key === null ? null : (await locked(query)).find((one) => one.key === key);
    if (area === undefined || (area !== null && area.state !== "active")) throw new AdminError("not_found");
    const next = area?.id ?? null;
    // The owner's word is recorded even where the project already reads so, by an agent's word or
    // by none, so that it stands from then on.
    const [last] = await query<{ by: string }>(
      "select by from ledger.record_events where row_kind = 'project' and row_id = $1 and event = 'updated' and code = 'area' order by id desc limit 1",
      [project],
    );
    if (row.area_id === next && last?.by === "owner") return;
    const label = [...new Set([...row.compartments, ...LABEL])].sort(byText);
    const seenByAll = LABEL.every((one) => row.compartments.includes(one));
    await query(
      `update knowledge.projects set area_id = $2, updated_at = case when $3::boolean then $4::timestamptz else updated_at end where id = $1`,
      [project, next, seenByAll, stamp(now)],
    );
    await recordEvent(query, PROJECT_AREA, project, stamp(now), label);
  });
}
