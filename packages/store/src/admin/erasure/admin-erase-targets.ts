// The owner's erase requests, each resolved to a target and applied by the erasure engine
// (admin-erase.ts): an item, a goal the owner set, an owner item, a person, or a device's forget. A
// repeated request id returns the first erasure's report; every target takes with it the goals
// adopted from what it erases.

import type {
  CaptureId,
  DocumentId,
  EntityId,
  ErasureId,
  ErasureReport,
  EventId,
  FactId,
  GoalId,
  MessageId,
  PageId,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import type { Query } from "../../core/db.ts";
import { allRulings, ownerFps } from "../../core/identity-rulings.ts";
import { newId } from "../../core/ids.ts";
import { notOwnerAddress } from "../../core/statements.ts";
import { groupOf, groupsOf } from "../../identity/groups.ts";
import { syncLock } from "../admin-base.ts";
import { apply, ITEM_ROWS, journalOf, type StoredErasure, type Target } from "./admin-erase.ts";

const reportOf = (row: StoredErasure): ErasureReport => ({
  erasure: row.id as ErasureId,
  items: row.items,
  people: row.kind === "person" ? 1 : 0,
  suppressed: row.suppressed,
  taintedRows: row.tainted_rows,
  exposedClients: row.exposed_client_ids.length,
  more: {},
});

// An erasure the owner asked for: a repeated request id returns the first erasure's report and
// does nothing; a dry run takes the sync lock and no other.
async function erase(
  admin: AdminContext,
  resolve: (query: Query) => Promise<Target>,
  options: { requestId: string; dryRun?: boolean },
): Promise<ErasureReport> {
  journalOf(admin);
  return admin.transaction(async (query) => {
    await syncLock(query);
    const dryRun = options.dryRun === true;
    if (!dryRun) {
      const [repeated] = await query<StoredErasure>(
        `select e.* from knowledge.erasures e join knowledge.owner_decisions d on d.id = e.ruling_id where d.request_id = $1`,
        [options.requestId],
      );
      if (repeated !== undefined) return reportOf(repeated);
    }
    return apply(admin, query, await withAdopted(query, await resolve(query)), {
      erasure: newId("ers") as ErasureId,
      requestId: options.requestId,
      dryRun,
      replay: null,
    });
  });
}

// Lens: one forget's pairs applied as an erasure of kind device_forget, in the caller's transaction
// after the sync lock, by the same steps as every erasure: the locks, the journal line, the
// removal, the hooks, and the erasure's own rows, with no ruling and no card. The caller has left
// out the pairs already removed; apply leaves them out again.
export async function applyDeviceForget(
  admin: AdminContext,
  query: Query,
  items: { accountId: string; fp: string }[],
): Promise<ErasureReport> {
  // And every goal made the owner's from a goal its items stated.
  const target = await withAdopted(query, { kind: "device_forget", items, entities: [], addressFps: [] });
  return apply(admin, query, target, {
    erasure: newId("ers") as ErasureId,
    requestId: "",
    dryRun: false,
    replay: null,
  });
}

export function eraseItem(
  admin: AdminContext,
  ref:
    | { kind: "message"; id: MessageId }
    | { kind: "event"; id: EventId }
    | { kind: "document"; id: DocumentId }
    | { kind: "page"; id: PageId }
    | { kind: "capture"; id: CaptureId },
  options: { requestId: string; dryRun?: boolean },
): Promise<ErasureReport> {
  return erase(
    admin,
    async (query) => {
      // Lens: a capture item by its knowledge.captures row, every split of a block day being an
      // item of its own.
      const [item] = await query<{ source_account_id: string; source_item_fp: string }>(
        `select e.source_account_id, e.source_item_fp from ${ITEM_ROWS[ref.kind]} k join vault.evidence_items e on e.id = k.evidence_id where k.id = $1`,
        [ref.id],
      );
      if (item === undefined) throw new AdminError("not_found");
      return {
        kind: "item",
        items: [{ accountId: item.source_account_id, fp: item.source_item_fp }],
        entities: [],
        addressFps: [],
      };
    },
    options,
  );
}

// A goal the owner set, erased as its owner_command items: the item of
// its goal_set and of each goal_reword, by their mapping rows. Their claims go with them, as any
// erased item's do, and each claim's mapping row with its claim (on delete cascade), so a restore's
// replay of the journal's items repeats it. The goal's state row is deleted too, after the journal
// line that names the goal, so an interrupted erasure's replay and a restore's replay delete it
// again; a goal with a state row and no mapping row (not yet backfilled, or erased
// before its state row went) is erased by its state row alone. Its decisions stay as ids: tainted,
// with the words their bodies held gone, so a rebuild of the goals' state passes over them.
async function goalTarget(query: Query, goal: string): Promise<Target> {
  // And the item of each target the owner named it by (`pia goal target --name`),
  // so its binding goes and the next sync removes the person when nothing else names them.
  const items = await query<{ source_account_id: string; source_item_fp: string }>(
    `select distinct e.source_account_id, e.source_item_fp from vault.evidence_items e
     where e.id in (
       select m.evidence_id from knowledge.goal_ids m where m.goal_id = $1
       union select d.details -> 'named' ->> 'item' from knowledge.owner_decisions d where d.kind = 'goal_target' and d.target_kind = 'goal' and d.target_id = $1)
     order by 1, 2`,
    [goal],
  );
  if (
    items.length === 0 &&
    (await query("select 1 from projections.goal_state where goal_id = $1", [goal])).length === 0
  )
    throw new AdminError("not_found");
  return {
    kind: "item",
    items: items.map((item) => ({ accountId: item.source_account_id, fp: item.source_item_fp })),
    entities: [],
    addressFps: [],
    goals: [goal],
  };
}

// A goal the owner made theirs from a goal stated in a source holds that source's words, so erasing
// the source erases it too, whole, as eraseGoal does, whether its adoption is in force or undone.
// The source goals are the keys of the claims the target's items hold, or that name its people,
// that are not the owner's own commands, and each goal is found by its `adopt` row on one of them.
// Added to the target before its journal line, so a replay repeats it.
async function withAdopted(query: Query, target: Target): Promise<Target> {
  const goals = await query<{ goal_id: string }>(
    `select distinct r.goal_id from knowledge.goal_key_rulings r
     where r.verdict = 'adopt'
       -- A goal erased already is gone: nothing of it is left to erase.
       and (exists (select 1 from projections.goal_state g where g.goal_id = r.goal_id) or exists (select 1 from knowledge.goal_ids m where m.goal_id = r.goal_id))
       and r.fact_key_fp in (
       select c.fact_key_fp from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
       where (e.source_account_id, e.source_item_fp) in (select * from unnest($1::text[], $2::text[])) and e.source_kind <> 'owner_command'
       union
       select c.fact_key_fp from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id join vault.evidence_items e on e.id = c.evidence_id
       where n.entity_id = any ($3::text[]) and e.source_kind <> 'owner_command')
     order by r.goal_id`,
    [target.items.map((item) => item.accountId), target.items.map((item) => item.fp), target.entities],
  );
  const more = goals.map((row) => row.goal_id).filter((goal) => !(target.goals ?? []).includes(goal));
  if (more.length === 0) return target;
  const items = new Map(target.items.map((item) => [`${item.accountId} ${item.fp}`, item]));
  for (const goal of more)
    for (const item of (await goalTarget(query, goal)).items) items.set(`${item.accountId} ${item.fp}`, item);
  return { ...target, items: [...items.values()], goals: [...(target.goals ?? []), ...more] };
}

export function eraseGoal(
  admin: AdminContext,
  goal: GoalId,
  options: { requestId: string; dryRun?: boolean },
): Promise<ErasureReport> {
  return erase(admin, (query) => goalTarget(query, goal), options);
}

// An item of a goal erases the goal whole, as eraseGoal does; any other is erased as an item.
// `not_found` for a claim of no owner_command item.
export function eraseOwnerItem(
  admin: AdminContext,
  claim: FactId,
  options: { requestId: string; dryRun?: boolean },
): Promise<ErasureReport> {
  return erase(
    admin,
    async (query) => {
      const [item] = await query<{ source_account_id: string; source_item_fp: string; goal_id: string | null }>(
        `select e.source_account_id, e.source_item_fp, (select m.goal_id from knowledge.goal_ids m where m.evidence_id = e.id limit 1) as goal_id
         from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id where c.id = $1 and e.source_kind = 'owner_command'`,
        [claim],
      );
      if (item === undefined) throw new AdminError("not_found");
      if (item.goal_id !== null) return goalTarget(query, item.goal_id);
      return {
        kind: "item",
        items: [{ accountId: item.source_account_id, fp: item.source_item_fp }],
        entities: [],
        addressFps: [],
      };
    },
    options,
  );
}

// The rulings committed before the erasure's exclusive taint lock are read by the identity hook
// after it, so none that holds an erased fingerprint is left.
export function erasePerson(
  admin: AdminContext,
  entity: EntityId,
  options: { requestId: string; dryRun?: boolean },
): Promise<ErasureReport> {
  return erase(
    admin,
    async (query) => {
      const [row] = await query<{ kind: string }>("select kind from knowledge.entities where id = $1", [entity]);
      if (row === undefined) throw new AdminError("not_found");
      if (row.kind !== "person") throw new AdminError("not_a_person");
      // An address the owner holds is the owner's, even while the person's row still holds it:
      // it is neither a route to the person's items nor suppressed.
      const own = (
        await query<{ value_fp: string }>(
          `select distinct a.value_fp from knowledge.accounts a where a.entity_id = $1
             and ${notOwnerAddress("a.value_fp")}
           order by a.value_fp`,
          [entity],
        )
      ).map((one) => one.value_fp);
      const groups = groupsOf(await allRulings(query), await ownerFps(query));
      const fps = [...new Set(own.flatMap((fp) => [...groupOf(groups, fp)]))].sort();
      // The person, with an address or none, and whoever else holds one of the group's addresses.
      const members = (
        await query<{ id: string }>(
          `select e.id from knowledge.entities e where e.id = $1
           union select e.id from knowledge.entities e join knowledge.accounts a on a.entity_id = e.id where e.kind = 'person' and a.value_fp = any($2)
           order by id`,
          [entity, fps],
        )
      ).map((one) => one.id);
      const items = await query<{ source_account_id: string; source_item_fp: string }>(
        `select distinct e.source_account_id, e.source_item_fp from vault.evidence_items e
         where e.id in (
           select evidence_id from knowledge.interaction_log where entity_id = any($1)
           union select evidence_id from knowledge.aliases where entity_id = any($1)
           union select v.evidence_id from knowledge.event_participants p join knowledge.events v on v.id = p.event_id where p.entity_id = any($1)
           union select evidence_id from knowledge.messages where sender_fp = any($2)
           union select evidence_id from vault.sent_recipients where address_fp = any($2)
           union select c.evidence_id from knowledge.contact_addresses k join knowledge.contacts c on c.id = k.contact_id where k.value_fp = any($2)
           union select evidence_id from knowledge.contacts where address_fps && $2::text[]
           union select evidence_id from knowledge.pages where about_entity_id = any($1)
           union select c.evidence_id from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id
             join vault.evidence_items v on v.id = c.evidence_id where n.entity_id = any($1) and v.source_kind = 'owner_command')
         order by 1, 2`,
        [members, fps],
      );
      // And the names the person was known by, so the sync's participant step makes no one of those
      // names again. A name's fingerprint is keyed apart from an address's, so it suppresses no
      // address; it is journalled with them, so a restore keeps it. And each phone handle of a
      // source moment a binding named them by, so the participant step never binds it again and the
      // captures hook cleans it from the facts.
      const names = (
        await query<{ value_fp: string }>(
          `select value_fp from knowledge.aliases where entity_id = any($1)
           union select b.mention_fp from knowledge.mention_bindings b join knowledge.captures c on c.evidence_id = b.evidence_id
           where c.source is not null and b.address_fp = any($2)
           order by 1`,
          [members, fps],
        )
      ).map((one) => one.value_fp);
      return {
        kind: "person",
        items: items.map((one) => ({ accountId: one.source_account_id, fp: one.source_item_fp })),
        entities: members,
        addressFps: fps,
        nameFps: names,
      };
    },
    options,
  );
}
