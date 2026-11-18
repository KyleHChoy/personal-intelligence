import { ownerDecision } from "../../core/owner-decision.ts";
// Erasures after the fact: the owner's list of them, the lift of one, and the replay that brings
// the database level with the journal (erasures, lifts, release lifts and retention rules). The
// lift and the replay each run behind the sync lock.

import type { Timestamp } from "@intelligence/contracts";
import type {
  ErasureId,
  PersonalCompartment,
  RetentionClass,
  RetentionRuleId,
  RulingId,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import {
  appendJournal,
  ensureJournal,
  type JournalEntry,
  erasureLevel as levelOf,
  readJournal,
} from "../../core/journal.ts";
import { BELIEFS_LOCK, GRANTS_LOCK } from "../../core/locks.ts";
import { lockRows } from "../../core/queue.ts";
import { removeReleased } from "../../write/writer-derived.ts";
import { syncLock } from "../admin-base.ts";
import { apply, journalOf, nextSeq, type StoredErasure, type Target } from "./admin-erase.ts";
import { writeRule } from "./admin-retention.ts";

type ErasureView = {
  id: ErasureId;
  kind: "item" | "person" | "device_forget";
  erasedAt: Timestamp;
  liftedAt: Timestamp | null;
  items: number;
  suppressed: number;
  exposedClients: number;
};

// Newest first.
export async function listErasures(admin: AdminContext): Promise<ErasureView[]> {
  const rows = await admin.transaction((query) =>
    query<StoredErasure>("select * from knowledge.erasures order by journal_seq desc"),
  );
  return rows.map((row) => ({
    id: row.id as ErasureId,
    kind: row.kind,
    erasedAt: stamp(row.erased_at),
    liftedAt: row.lifted_at === null ? null : stamp(row.lifted_at),
    items: row.items,
    suppressed: row.suppressed,
    exposedClients: row.exposed_client_ids.length,
  }));
}

// False for an id that is no erasure, or one already lifted. A forget from a Mac sticks: its
// erasure is refused `not_permitted`.
async function lift(
  admin: AdminContext,
  query: Query,
  id: ErasureId,
  options: { requestId: string; replay: number | null },
): Promise<boolean> {
  const journal = journalOf(admin);
  await lockRows(query, []);
  const [row] = await query<{
    ruling_id: string;
    kind: StoredErasure["kind"];
    compartments: PersonalCompartment[];
    lifted_at: Date | null;
  }>("select ruling_id, kind, compartments, lifted_at from knowledge.erasures where id = $1 for update", [id]);
  if (row === undefined || row.lifted_at !== null) return false;
  if (row.kind === "device_forget") throw new AdminError("not_permitted");
  const seq = options.replay ?? (await nextSeq(query, journal));
  const now = admin.now();
  await query("delete from knowledge.suppressions where erasure_id = $1", [id]);
  await query("delete from knowledge.removed_evidence where erasure_id = $1", [id]);
  await query("update knowledge.erasures set lift_seq = $2, lifted_at = $3 where id = $1", [id, seq, stamp(now)]);
  if (options.replay === null) await appendJournal(journal, { seq, lift: id } as JournalEntry);
  await ownerDecision(
    query,
    {
      requestId: options.requestId,
      kind: "erase_lift",
      supersedes: row.ruling_id as RulingId,
      compartments: row.compartments,
    },
    now,
  );
  return true;
}

export function liftErasure(admin: AdminContext, id: ErasureId, options: { requestId: string }): Promise<boolean> {
  journalOf(admin);
  return admin.transaction(async (query) => {
    await syncLock(query);
    return lift(admin, query, id, { requestId: options.requestId, replay: null });
  });
}

// A replayed entry's target: its items as the journal names them, and for a person the people it
// names that are here, with the person entities that hold one of its suppressed addresses now. Its
// suppressed fingerprints are its addresses and its names both, since the line does not tell them
// apart. A `device_forget` line's pairs are its target as they stand, applied on apply's
// device_forget branch.
async function targetOf(query: Query, entry: Extract<JournalEntry, { erasure: ErasureId }>): Promise<Target> {
  const entities =
    entry.kind === "person"
      ? (
          await query<{ id: string }>(
            `select e.id from knowledge.entities e where e.kind = 'person' and e.id = any($2)
             union select e.id from knowledge.entities e join knowledge.accounts a on a.entity_id = e.id where e.kind = 'person' and a.value_fp = any($1)
             order by id`,
            [entry.suppress, entry.entities ?? []],
          )
        ).map((row) => row.id)
      : [];
  return {
    kind: entry.kind,
    items: entry.items.map((item) => ({ accountId: item.account, fp: item.fp })),
    entities,
    addressFps: entry.suppress,
    nameFps: entry.suppress,
    ...(entry.goals === undefined ? {} : { goals: entry.goals }),
  };
}

// Invariant 10: the replay of a journalled release lift the database lacks (a restore from before
// it). Its line recorded again, so policy.released_records() takes no release it names, and its
// record's released claims removed with what rests on them. The lift of the confirmation too, when
// the restore brought the confirm back in force, a confirmation_lift decision superseding it again,
// so policy.confirmed_claims no longer answers for it, and the release row lifted under it. A
// standing grant's ruling covers many records, so every release row under it is lifted and every
// one's released claims removed, unless another release of that record is in force, and its lift is
// written as `pi facts grant-lift` writes one, a release_grant_lift.
async function replayReleaseLift(admin: AdminContext, query: Query, ruling: RulingId, seq: number): Promise<void> {
  await query("insert into knowledge.release_lifts (seq, ruling_id, compartments) values ($1, $2, array['own'])", [
    seq,
    ruling,
  ]);
  const [confirm] = await query<{ kind: string; compartments: PersonalCompartment[] }>(
    "select o.kind, o.compartments from knowledge.owner_decisions o where o.id = $1 and not exists (select 1 from knowledge.owner_decisions s where s.supersedes = o.id)",
    [ruling],
  );
  if (confirm !== undefined) {
    const now = admin.now();
    const lift = await ownerDecision(
      query,
      {
        requestId: `replay_release_lift_${seq}`,
        kind: confirm.kind === "release_grant" ? "release_grant_lift" : "confirmation_lift",
        supersedes: ruling,
        compartments: confirm.compartments,
      },
      now,
    );
    await query(
      "update knowledge.claim_releases set lifted_at = $2, lift_ruling_id = $3 where ruling_id = $1 and lifted_at is null",
      [ruling, stamp(now), lift],
    );
  }
  const releases = await query<{ evidence_id: string }>(
    `select r.evidence_id from knowledge.claim_releases r
     where r.ruling_id = $1 and not exists (select 1 from policy.released_records() f where f.evidence_id = r.evidence_id and f.ruling_id <> r.ruling_id)
     order by r.evidence_id`,
    [ruling],
  );
  for (const { evidence_id } of releases) await removeReleased(query, evidence_id);
}

// A failed entry rolls back alone, is logged by its sequence number, and stops the replay: the
// entries before it stay applied.
export async function replayErasures(admin: AdminContext): Promise<{ applied: number; journalled: number }> {
  const journal = journalOf(admin);
  const { entries } = await readJournal(journal);
  const held = await admin.transaction((query) =>
    query<{ journal_seq: string; lift_seq: string | null }>(
      "select journal_seq::text, lift_seq::text from knowledge.erasures",
    ),
  );
  // The release lifts the database holds.
  const releaseLifts = await admin.transaction((query) =>
    query<{ seq: string }>("select seq::text from knowledge.release_lifts"),
  );
  // And the retention rules.
  const rules = await admin.transaction((query) =>
    query<{ seq: string }>("select journal_seq::text as seq from policy.retention_rules"),
  );
  const inDatabase = new Set([
    ...held.flatMap((row) => [Number(row.journal_seq), ...(row.lift_seq === null ? [] : [Number(row.lift_seq)])]),
    ...releaseLifts.map((row) => Number(row.seq)),
    ...rules.map((row) => Number(row.seq)),
  ]);

  let applied = 0;
  for (const entry of entries) {
    if (inDatabase.has(entry.seq)) continue;
    // A retention entry is replayed by writing its decision and its rule with the entry's number
    // and id. A seal or unseal entry, which nothing here writes, is refused, never passed over.
    if ("retention" in entry) {
      try {
        await admin.transaction(async (query) => {
          await syncLock(query);
          await writeRule(
            admin,
            query,
            { class: entry.class, days: entry.days, account: entry.account },
            {
              requestId: `replay_retention_${entry.retention.slice(4)}`,
              replay: { seq: entry.seq, id: entry.retention },
            },
          );
        });
      } catch (error) {
        admin.log.error({ event: "erasure_replay_failed", counts: { seq: entry.seq } });
        throw error;
      }
      applied += 1;
      continue;
    }
    if (!("lift" in entry) && !("erasure" in entry) && !("releaseLift" in entry)) {
      admin.log.error({ event: "erasure_replay_failed", counts: { seq: entry.seq } });
      throw new AdminError("journal_refused");
    }
    const id = "lift" in entry ? entry.lift : "releaseLift" in entry ? entry.releaseLift : entry.erasure;
    try {
      await admin.transaction(async (query) => {
        // A release lift in the order `pi facts grant-lift` and `pi correct
        // lift` take their locks: the beliefs lock, the release grants' lock (no release is written
        // under the ruling while it is lifted), the decisions' lock, then the sync lock.
        if ("releaseLift" in entry) {
          await query(BELIEFS_LOCK);
          await query(GRANTS_LOCK);
          await lockRows(query, []);
        }
        await syncLock(query);
        if ("releaseLift" in entry) {
          await replayReleaseLift(admin, query, entry.releaseLift, entry.seq);
        } else if ("lift" in entry) {
          if (
            !(await lift(admin, query, entry.lift, {
              requestId: `replay_lift_${entry.lift.slice(4)}`,
              replay: entry.seq,
            }))
          )
            throw new AdminError("not_found");
        } else {
          await apply(admin, query, await targetOf(query, entry), {
            erasure: entry.erasure,
            requestId: `replay_erase_${entry.erasure.slice(4)}`,
            dryRun: false,
            replay: entry.seq,
          });
        }
      });
    } catch (error) {
      admin.log.error({
        event: "erasure_replay_failed",
        ids: { [`releaseLift` in entry ? "ruling" : "erasure"]: id },
        counts: { seq: entry.seq },
      });
      throw error;
    }
    applied += 1;
  }

  const journalled = await admin.transaction(async (query) => {
    await syncLock(query);
    const rows = await query<StoredErasure>("select * from knowledge.erasures order by journal_seq");
    const { seq: last } = await readJournal(journal);
    const missing: JournalEntry[] = [];
    for (const row of rows) {
      const items = await query<{ source_account_id: string; source_item_fp: string }>(
        "select source_account_id, source_item_fp from knowledge.removed_evidence where erasure_id = $1 order by source_account_id, source_item_fp",
        [row.id],
      );
      const suppress = (
        await query<{ value_fp: string }>(
          "select value_fp from knowledge.suppressions where erasure_id = $1 order by value_fp",
          [row.id],
        )
      ).map((one) => one.value_fp);
      if (Number(row.journal_seq) > last) {
        missing.push({
          seq: Number(row.journal_seq),
          erasure: row.id,
          kind: row.kind,
          items: items.map((one) => ({ account: one.source_account_id, fp: one.source_item_fp })),
          suppress,
        } as JournalEntry);
      }
      if (row.lift_seq !== null && Number(row.lift_seq) > last)
        missing.push({ seq: Number(row.lift_seq), lift: row.id } as JournalEntry);
    }
    for (const row of await query<{ seq: string; ruling_id: RulingId }>(
      "select seq::text, ruling_id from knowledge.release_lifts",
    )) {
      if (Number(row.seq) > last) missing.push({ seq: Number(row.seq), releaseLift: row.ruling_id });
    }
    for (const row of await query<{
      seq: string;
      id: RetentionRuleId;
      class: RetentionClass;
      account_id: SourceAccountId | null;
      days: number | null;
    }>("select journal_seq::text as seq, id, class, account_id, days from policy.retention_rules")) {
      if (Number(row.seq) > last)
        missing.push({
          seq: Number(row.seq),
          retention: row.id,
          class: row.class,
          account: row.account_id,
          days: row.days,
        });
    }
    missing.sort((left, right) => left.seq - right.seq);
    let next = last;
    for (const entry of missing) {
      // The database's numbers follow the journal's, or the journal is not the one it was kept with.
      if (entry.seq !== next + 1) throw new AdminError("journal_refused");
      await appendJournal(journal, entry);
      next = entry.seq;
    }
    if (next === 0) await ensureJournal(journal);
    return missing.length;
  });
  return { applied, journalled };
}

export async function erasureLevel(admin: AdminContext): Promise<"level" | "behind"> {
  const journal = journalOf(admin);
  return admin.transaction(async (query) => {
    await syncLock(query);
    return levelOf(query, journal);
  });
}
