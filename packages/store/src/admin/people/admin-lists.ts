import type { Timestamp } from "@intelligence/contracts";
import {
  type EntityId,
  ListCreateBody,
  type OwnerListId,
  ownLabel,
  type PersonalCompartment,
  type RulingId,
  type Who,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { byText, type Query, stamp } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { type Decision, lockRows } from "../../core/queue.ts";
import type { Sealed } from "../../core/seal.ts";
import { open, sealUnder } from "../../core/seal.ts";
import { ownerWho } from "../admin-owner.ts";
import { ruledOf } from "../rulings/admin-tier-rows.ts";
import { RULING_LOCKS } from "../rulings/owner-ruling.ts";

// The owner's lists of people, `pia lists`. A list is a row of knowledge.owner_lists, its name the owner's
// free text sealed under `own` and never logged. A member is a row of knowledge.owner_list_members holding
// the keyed fingerprints of the person's addresses and phone keys, as a tier ruling does (admin-tier.ts),
// so membership outlives a re-derive's new ids and follows an identity merge: whoever holds one of the
// fingerprints now is the member. Create, rename, delete, add and remove are each one owner decision,
// written in one transaction with its rows. Lists are the owner's only: no agent read reaches them.

const NAME = ListCreateBody.shape.name;

// `people`: each member ownerWho names, in `members`' order; one it does not name is left out.
export type OwnerListView = { id: OwnerListId; name: string; createdAt: Timestamp; members: EntityId[]; people: Who[] };

const sealedName = (admin: AdminContext, list: string, name: string) =>
  sealUnder(admin.keys, ownLabel(), { table: "knowledge.owner_lists", id: list, column: "name_enc" }, name);

function checkedName(name: string): string {
  if (!NAME.safeParse(name).success) throw new AdminError("invalid_argument");
  return name;
}

// The decision a repeated request id wrote, or undefined. One of another kind is `invalid_argument`.
async function repeatOf(query: Query, requestId: string, kind: Decision["kind"]): Promise<RulingId | undefined> {
  const [repeat] = await query<{ id: RulingId; kind: string }>(
    "select id, kind from knowledge.owner_decisions where request_id = $1",
    [requestId],
  );
  if (repeat !== undefined && repeat.kind !== kind) throw new AdminError("invalid_argument");
  return repeat?.id;
}

// A list that is not deleted, or `not_found`.
async function liveList(query: Query, list: string): Promise<void> {
  const [row] = await query<{ id: string }>(
    "select id from knowledge.owner_lists where id = $1 and deleted_at is null",
    [list],
  );
  if (row === undefined) throw new AdminError("not_found");
}

// The list's member rows in force on any of these fingerprints, newest first.
const membersOn = (query: Query, list: string, fps: string[]) =>
  query<{ ruling_id: RulingId; value_fps: string[]; compartments: PersonalCompartment[] }>(
    `select ruling_id, value_fps, compartments from knowledge.owner_list_members
     where list_id = $1 and removed_at is null and value_fps && $2::text[] order by created_at desc, ruling_id collate "C" desc`,
    [list, fps],
  );

// `pia lists create`, the name from stdin: the new list's id.
export async function createList(
  admin: AdminContext,
  name: string,
  options: { requestId: string },
): Promise<OwnerListId> {
  checkedName(name);
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [RULING_LOCKS.lists]);
    const repeat = await repeatOf(query, options.requestId, "list_create");
    if (repeat !== undefined) {
      const [made] = await query<{ id: OwnerListId }>("select id from knowledge.owner_lists where ruling_id = $1", [
        repeat,
      ]);
      if (made === undefined) throw new AdminError("not_found");
      return made.id;
    }
    const ruling = await ownerDecision(query, { kind: "list_create", requestId: options.requestId }, now);
    const id = newId("lst") as OwnerListId;
    await query(
      "insert into knowledge.owner_lists (id, ruling_id, name_enc, named_by, created_at, compartments) values ($1, $2, $3, $2, $4, $5)",
      [id, ruling, sealedName(admin, id, name), stamp(now), ownLabel()],
    );
    return id;
  });
}

// `pia lists rename LIST`, the name from stdin. Its undo is a rename again.
export async function renameList(
  admin: AdminContext,
  list: OwnerListId,
  name: string,
  options: { requestId: string },
): Promise<RulingId> {
  checkedName(name);
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [RULING_LOCKS.lists]);
    const repeat = await repeatOf(query, options.requestId, "list_rename");
    if (repeat !== undefined) return repeat;
    await liveList(query, list);
    const ruling = await ownerDecision(query, { kind: "list_rename", requestId: options.requestId }, now);
    await query("update knowledge.owner_lists set name_enc = $2, named_by = $3 where id = $1", [
      list,
      sealedName(admin, list, name),
      ruling,
    ]);
    return ruling;
  });
}

// `pia lists delete LIST`: the list and its members are read by nothing after it. Its member rows in
// force are removed by the same decision; the rows stay, until an erasure reaches a fingerprint.
export async function deleteList(
  admin: AdminContext,
  list: OwnerListId,
  options: { requestId: string },
): Promise<RulingId> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [RULING_LOCKS.lists]);
    const repeat = await repeatOf(query, options.requestId, "list_delete");
    if (repeat !== undefined) return repeat;
    await liveList(query, list);
    const ruling = await ownerDecision(query, { kind: "list_delete", requestId: options.requestId }, now);
    await query("update knowledge.owner_lists set deleted_at = $2, delete_ruling_id = $3 where id = $1", [
      list,
      stamp(now),
      ruling,
    ]);
    await query(
      "update knowledge.owner_list_members set removed_at = $2, remove_ruling_id = $3 where list_id = $1 and removed_at is null",
      [list, stamp(now), ruling],
    );
    return ruling;
  });
}

// `pia lists add LIST PERSON`, by entity id or by an address the person holds. A person already a
// member by every fingerprint is `already_settled` with the member's ruling, and nothing is
// written; one who holds a fingerprint no member row of the list does (a new address since) is
// added again by all of them, and the rows in force on any of them are removed by the new one.
export async function addToList(
  admin: AdminContext,
  list: OwnerListId,
  person: EntityId | string,
  options: { requestId: string },
): Promise<RulingId> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [RULING_LOCKS.lists]);
    const repeat = await repeatOf(query, options.requestId, "list_add");
    if (repeat !== undefined) return repeat;
    await liveList(query, list);
    const { fps, compartments } = await ruledOf(admin, query, person);
    const live = await membersOn(query, list, fps);
    const held = new Set(live.flatMap((row) => row.value_fps));
    if (fps.every((fp) => held.has(fp)))
      throw new AdminError("already_settled", undefined, live.map((row) => row.ruling_id).sort(byText));
    const ruling = await ownerDecision(
      query,
      {
        kind: "list_add",
        requestId: options.requestId,
        compartments,
        supersedes: live[0]?.ruling_id ?? null,
        subjectFps: fps,
      },
      now,
    );
    if (live.length > 0) {
      await query(
        "update knowledge.owner_list_members set removed_at = $2, remove_ruling_id = $3 where ruling_id = any($1::text[])",
        [live.map((row) => row.ruling_id), stamp(now), ruling],
      );
    }
    await query(
      "insert into knowledge.owner_list_members (ruling_id, list_id, value_fps, created_at, compartments) values ($1, $2, $3, $4, $5)",
      [ruling, list, fps, stamp(now), compartments],
    );
    return ruling;
  });
}

// `pia lists remove LIST PERSON`: every member row of the list in force on the person's
// fingerprints, removed by one `list_remove` decision. False when none is in force; a repeated
// request id answers true again and writes nothing.
export async function removeFromList(
  admin: AdminContext,
  list: OwnerListId,
  person: EntityId | string,
  options: { requestId: string },
): Promise<boolean> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [RULING_LOCKS.lists]);
    if ((await repeatOf(query, options.requestId, "list_remove")) !== undefined) return true;
    await liveList(query, list);
    const { fps } = await ruledOf(admin, query, person);
    const live = await membersOn(query, list, fps);
    if (live.length === 0) return false;
    const label = [...new Set(live.flatMap((row) => row.compartments))].sort(byText);
    const lift = await ownerDecision(
      query,
      {
        kind: "list_remove",
        requestId: options.requestId,
        compartments: label,
        supersedes: live[0]!.ruling_id,
        subjectFps: live.flatMap((row) => row.value_fps),
      },
      now,
    );
    await query(
      "update knowledge.owner_list_members set removed_at = $2, remove_ruling_id = $3 where ruling_id = any($1::text[])",
      [live.map((row) => row.ruling_id), stamp(now), lift],
    );
    return true;
  });
}

// `pia lists`: the lists not deleted, oldest first, each with its name (the command prints to a
// terminal only) and the people who hold a fingerprint of a member row in force now.
export async function lists(admin: AdminContext): Promise<OwnerListView[]> {
  return admin.transaction(async (query) => {
    const rows = await query<{
      id: OwnerListId;
      name_enc: Sealed;
      compartments: string[];
      created_at: Date;
      members: string[];
    }>(
      `select l.id, l.name_enc, l.compartments, l.created_at,
         array(select distinct a.entity_id from knowledge.owner_list_members m
               join knowledge.accounts a on a.value_fp = any(m.value_fps)
               join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
               where m.list_id = l.id and m.removed_at is null order by a.entity_id) as members
       from knowledge.owner_lists l where l.deleted_at is null order by l.created_at, l.id collate "C"`,
    );
    const who = await ownerWho(
      { query, keys: admin.keys },
      rows.flatMap((row) => row.members),
    );
    return rows.map((row) => ({
      id: row.id,
      name: open(admin.keys, row, "knowledge.owner_lists.name_enc", "throw"),
      createdAt: stamp(row.created_at),
      members: row.members as EntityId[],
      people: row.members.flatMap((member) => who.get(member) ?? []),
    }));
  });
}
