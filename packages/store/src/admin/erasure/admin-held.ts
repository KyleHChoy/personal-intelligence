import { randomBytes } from "node:crypto";
import type { Timestamp } from "@intelligence/contracts";
import { DocumentId, MessageId } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { stamp } from "../../core/db.ts";
import { recordRelease } from "../../core/queue.ts";
import type { Sealed } from "../../core/seal.ts";
import { openedUnder } from "../../core/tx.ts";

// Held mail and held Drive documents: the owner's lists of them, a held document's title, and their
// release by id or by age, each release in a transaction of its own with its release decision.

const HELD_LISTED = 50;
const YEAR_ONE_MS = Date.parse("0001-01-01T00:00:00Z");

// How many knowledge.messages rows are held, and the newest 50 of them by sent_at, then id,
// each with what held it: the decide model, when its evidence row carries the decide model's hold, else the
// recovery markers. Opens no sealed value: an id, a time and a word are not content.
export function heldMessages(
  admin: AdminContext,
): Promise<{ held: number; messages: { id: MessageId; at: Timestamp; by: "markers" | "jev" }[] }> {
  return admin.transaction(async (query) => {
    const [counted] = await query<{ held: number }>("select count(*)::int as held from knowledge.messages where held");
    const newest = await query<{ id: string; sent_at: Date; jev: boolean }>(
      `select m.id, m.sent_at, e.model_hold_at is not null as jev from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id
       where m.held order by m.sent_at desc, m.id limit $1`,
      [HELD_LISTED],
    );
    return {
      held: counted?.held ?? 0,
      messages: newest.map((row) => ({
        id: row.id as MessageId,
        at: stamp(row.sent_at),
        by: row.jev ? ("jev" as const) : ("markers" as const),
      })),
    };
  });
}

// Each message is released in a transaction of its own: the time on the evidence row its message
// row cites, which is its latest revision's, and `held` false on the message row. Throws AdminError
// "not_found" for an id that is no MessageId or names no held message, and "invalid_argument" for
// an age that is no positive integer or whose cutoff is no date or falls before year 1.
export async function releaseHeld(
  admin: AdminContext,
  which: { id: string } | { olderThanDays: number },
): Promise<{ released: number }> {
  const own = randomBytes(12).toString("base64url");
  if ("id" in which) {
    if (!MessageId.safeParse(which.id).success || !(await releaseMessage(admin, which.id, own, false)))
      throw new AdminError("not_found");
    return { released: 1 };
  }
  const days = which.olderThanDays;
  if (typeof days !== "number" || !Number.isSafeInteger(days) || days < 1) throw new AdminError("invalid_argument");
  const date = new Date(admin.now().getTime() - days * DAY_MS);
  // A safe integer of days can reach past the range a Date holds, or before year 1, whose
  // dates the database cannot take. NaN fails the comparison too.
  if (!(date.getTime() >= YEAR_ONE_MS)) throw new AdminError("invalid_argument");
  const before = stamp(date);
  const ids = await admin.transaction((query) =>
    query<{ id: string }>("select id from knowledge.messages where held and sent_at < $1 order by sent_at, id", [
      before,
    ]),
  );
  let released = 0;
  for (const { id } of ids) if (await releaseMessage(admin, id, own, ids.length > 1)) released += 1;
  return { released };
}

// One held message released, in one transaction with its release decision; false when no
// held message has that id.
function releaseMessage(admin: AdminContext, id: string, own: string, batch: boolean): Promise<boolean> {
  return admin.transaction(async (query) => {
    // Locked by id, and `held` read from the locked row: a hold the decide model's mark_recovery has not yet
    // committed is waited for, not passed over as a row that was not held.
    const [message] = await query<{ evidence_id: string; held: boolean }>(
      "select evidence_id, held from knowledge.messages where id = $1 for update",
      [id],
    );
    if (message === undefined || !message.held) return false;
    await query("update vault.evidence_items set hold_released_at = $2 where id = $1", [
      message.evidence_id,
      stamp(admin.now()),
    ]);
    await query("update knowledge.messages set held = false where id = $1", [id]);
    await recordRelease(query, id as MessageId, { requestId: `${own}_${id.slice(4)}`, batch, now: admin.now() });
    return true;
  });
}

// Opens no sealed value: an id, a kind and a time are not content; `pi documents held` opens
// titles.
export function heldDocuments(
  admin: AdminContext,
): Promise<{ held: number; documents: { id: DocumentId; kind: string; modifiedAt: Timestamp }[] }> {
  return admin.transaction(async (query) => {
    const [counted] = await query<{ held: number }>("select count(*)::int as held from knowledge.documents where held");
    const newest = await query<{ id: string; kind: string; modified_at: Date }>(
      "select id, kind, modified_at from knowledge.documents where held order by modified_at desc, id limit $1",
      [HELD_LISTED],
    );
    return {
      held: counted?.held ?? 0,
      documents: newest.map((row) => ({
        id: row.id as DocumentId,
        kind: row.kind,
        modifiedAt: stamp(row.modified_at),
      })),
    };
  });
}

// A held document's title, for `pi documents held` on a terminal.
export function documentTitle(admin: AdminContext, id: string): Promise<string | null> {
  return admin.transaction(async (query) => {
    const [row] = await query<{ title_enc: Sealed; compartments: string[] }>(
      "select title_enc, compartments from knowledge.documents where id = $1",
      [id],
    );
    return row === undefined
      ? null
      : openedUnder(
          admin.keys,
          row.compartments,
          { table: "knowledge.documents", id, column: "title_enc" },
          row.title_enc,
        );
  });
}

// A release covers the revision released: a new revision that still matches is held again. Throws
// AdminError "not_found" for an id that names no held document, "invalid_argument" for a bad age.
export async function releaseHeldDocuments(
  admin: AdminContext,
  which: { id: string } | { olderThanDays: number },
): Promise<{ released: number }> {
  const own = randomBytes(12).toString("base64url");
  if ("id" in which) {
    if (!DocumentId.safeParse(which.id).success || !(await releaseDocument(admin, which.id, own, false)))
      throw new AdminError("not_found");
    return { released: 1 };
  }
  const days = which.olderThanDays;
  if (typeof days !== "number" || !Number.isSafeInteger(days) || days < 1) throw new AdminError("invalid_argument");
  const date = new Date(admin.now().getTime() - days * DAY_MS);
  if (!(date.getTime() >= YEAR_ONE_MS)) throw new AdminError("invalid_argument");
  const ids = await admin.transaction((query) =>
    query<{ id: string }>(
      "select id from knowledge.documents where held and modified_at < $1 order by modified_at, id",
      [stamp(date)],
    ),
  );
  let released = 0;
  for (const { id } of ids) if (await releaseDocument(admin, id, own, ids.length > 1)) released += 1;
  return { released };
}

function releaseDocument(admin: AdminContext, id: string, own: string, batch: boolean): Promise<boolean> {
  return admin.transaction(async (query) => {
    const [document] = await query<{ evidence_id: string }>(
      "select evidence_id from knowledge.documents where id = $1 and held for update",
      [id],
    );
    if (document === undefined) return false;
    await query("update vault.evidence_items set hold_released_at = $2 where id = $1", [
      document.evidence_id,
      stamp(admin.now()),
    ]);
    await query("update knowledge.documents set held = false where id = $1", [id]);
    await recordRelease(query, id as DocumentId, { requestId: `${own}_${id.slice(4)}`, batch, now: admin.now() });
    return true;
  });
}
