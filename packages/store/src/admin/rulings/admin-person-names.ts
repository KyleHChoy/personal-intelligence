import type { EntityId, PersonalCompartment, RulingId } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { byText, type Query, stamp } from "../../core/db.ts";
import { personNameId } from "../../core/ids.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import type { Sealed } from "../../core/seal.ts";
import { sealUnder } from "../../core/seal.ts";
import { openedUnder } from "../../core/tx.ts";
import { currentGroupMembers } from "../people/admin-people.ts";
import { liftRulings, lockedRepeat, OWNER_NAME, RULING_LOCKS } from "./owner-ruling.ts";

// The owner's name for a person: `pia person name PERSON NAME`, one `person_name` decision and one
// knowledge.person_names row holding the person's id, its anchor, and the fingerprints of the person's own
// addresses, sealed under the union of the group's account rows' labels (else its aliases', else `own`). By
// id, a person known by a name alone is named; every read resolves the anchor's identity group as the
// owner's rulings make it then; by address, a record that later holds one is named too, and the name
// outlives a re-derive. A new name lifts the names in force on the group; `--clear` (a null name) lifts
// them, and so does the Undo of a name (`pia person name lift RULING`), which puts back the names it
// lifted: each a `person_name_lift` decision that supersedes the ruling it undoes. No claim is written or
// edited: every read that names a person ranks the owner's live name above every alias
// (person-name-rows.ts).

const TABLE = "knowledge.person_names";

type Row = {
  id: string;
  entity_ids: string[];
  value_fps: string[];
  name_enc: Sealed;
  compartments: string[];
  lifted_at: Date | null;
};
const COLUMNS = "id, entity_ids, value_fps, name_enc, compartments, lifted_at";
// The live rows that name any of the ids ($1) or the fingerprints ($2).
const LIVE = `select ruling_id from ${TABLE} where lifted_at is null and (entity_ids && $1::text[] or value_fps && $2::text[]) order by id`;

const sorted = (values: readonly string[]): string[] => [...new Set(values)].sort(byText);

// The person's group, its addresses' fingerprints and their label: `not_found` for an id that names
// no person.
async function groupOf(
  query: Query,
  person: EntityId,
): Promise<{ members: string[]; fps: string[]; own: string[]; compartments: PersonalCompartment[] }> {
  const [entity] = await query<{ kind: string }>("select kind from knowledge.entities where id = $1", [person]);
  if (entity?.kind !== "person") throw new AdminError("not_found");
  const members = sorted(await currentGroupMembers(query, person));
  const accounts = await query<{ entity_id: string; value_fp: string; compartments: string[] }>(
    "select a.entity_id, a.value_fp, a.compartments from knowledge.accounts a where a.entity_id = any ($1::text[]) order by a.id",
    [members],
  );
  const labels =
    accounts.length > 0
      ? accounts.map((row) => row.compartments)
      : (
          await query<{ compartments: string[] }>(
            "select s.compartments from knowledge.aliases s where s.entity_id = any ($1::text[]) order by s.id",
            [members],
          )
        ).map((row) => row.compartments);
  const compartments = sorted(labels.flat());
  return {
    members,
    fps: sorted(accounts.map((row) => row.value_fp)),
    own: sorted(accounts.filter((row) => row.entity_id === person).map((row) => row.value_fp)),
    compartments: compartments.length === 0 ? ["own"] : compartments,
  };
}

const insertName = async (
  admin: AdminContext,
  query: Query,
  ruling: RulingId,
  row: { entity_ids: string[]; value_fps: string[] },
  name: string,
  compartments: readonly string[],
  now: Date,
): Promise<void> => {
  const id = personNameId();
  await query(
    `insert into ${TABLE} (id, ruling_id, entity_ids, value_fps, name_enc, created_at, compartments) values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      ruling,
      row.entity_ids,
      row.value_fps,
      sealUnder(admin.keys, [...compartments], { table: TABLE, id, column: "name_enc" }, name),
      stamp(now),
      [...compartments],
    ],
  );
};

// The owner's name, or with null their clear of it. A clear with no name of theirs in force is
// `not_found`.
export async function namePerson(
  admin: AdminContext,
  person: EntityId,
  name: string | null,
  options: { requestId: string },
): Promise<RulingId> {
  const named = name?.trim() ?? null;
  if (named !== null && !OWNER_NAME.test(named)) throw new AdminError("invalid_argument");
  const now = admin.now();
  return admin.transaction(async (query) => {
    const repeat = await lockedRepeat(query, RULING_LOCKS.personNames, options.requestId);
    if (repeat !== undefined) return repeat;
    const { members, fps, own, compartments } = await groupOf(query, person);
    const live = await query<{ ruling_id: RulingId }>(LIVE, [members, fps]);
    if (named === null && live.length === 0) throw new AdminError("not_found");
    const ruling = await ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: named === null ? "person_name_lift" : "person_name",
        target: { kind: "entity", id: person },
        supersedes: live[0]?.ruling_id ?? null,
        compartments,
      },
      now,
    );
    await query(
      `update ${TABLE} set lifted_at = $3, lift_ruling_id = $4 where lifted_at is null and (entity_ids && $1::text[] or value_fps && $2::text[])`,
      [members, fps, stamp(now), ruling],
    );
    // The row holds the person the owner named, its anchor, and that person's own addresses; every
    // read resolves the anchor's group as the owner's rulings make it then (hisNames), so a later
    // split leaves the name with the anchor's half alone.
    if (named !== null)
      await insertName(admin, query, ruling, { entity_ids: [person], value_fps: own }, named, compartments, now);
    return ruling;
  });
}

// The Undo of a name or a clear: the rows the ruling wrote are lifted, and the rows it lifted come
// back, each as a new row of the Undo's own, of the same name, people and label. Only while the
// ruling's effect stands: a ruling of the owner's made since is `not_found` here, as an Undo of a ruling
// already lifted is.
export async function liftPersonName(
  admin: AdminContext,
  ruling: RulingId,
  options: { requestId: string },
): Promise<RulingId> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    const repeat = await lockedRepeat(query, RULING_LOCKS.personNames, options.requestId);
    if (repeat !== undefined) return repeat;
    const [decision] = await query<{ target_id: EntityId | null; compartments: string[] }>(
      "select target_id, compartments from knowledge.owner_decisions where id = $1 and kind in ('person_name', 'person_name_lift')",
      [ruling],
    );
    if (decision === undefined || decision.target_id === null) throw new AdminError("not_found");
    const wrote = await query<Row>(`select ${COLUMNS} from ${TABLE} where ruling_id = $1 order by id`, [ruling]);
    const lifted = await query<Row>(`select ${COLUMNS} from ${TABLE} where lift_ruling_id = $1 order by id`, [ruling]);
    const both = [...wrote, ...lifted];
    // Its effect stands when every row it wrote is live and nothing else is live on its people.
    const live =
      both.length === 0
        ? []
        : await query<{ ruling_id: string }>(LIVE, [
            sorted(both.flatMap((row) => row.entity_ids)),
            sorted(both.flatMap((row) => row.value_fps)),
          ]);
    if (
      both.length === 0 ||
      live.some((row) => row.ruling_id !== ruling) ||
      wrote.some((row) => row.lifted_at !== null)
    )
      throw new AdminError("not_found");
    const undo = await ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "person_name_lift",
        target: { kind: "entity", id: decision.target_id },
        supersedes: ruling,
        compartments: decision.compartments,
      },
      now,
    );
    await liftRulings(query, TABLE, [ruling], undo, now);
    for (const row of lifted) {
      const name = openedUnder(
        admin.keys,
        row.compartments,
        { table: TABLE, id: row.id, column: "name_enc" },
        row.name_enc,
      );
      await insertName(admin, query, undo, row, name, row.compartments, now);
    }
    return undo;
  });
}
