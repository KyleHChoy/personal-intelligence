import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import { type CaptureId, SourceAccountId } from "@intelligence/contracts/personal";
import type { CaptureFacts } from "@intelligence/personal-core/lens";
import { hashFingerprint, sha256Hex, testId } from "./clients.ts";
import { session } from "./connections.ts";
import { fingerprint, sealRow, type TestDatabase } from "./database.ts";
import { seeder } from "./seeder.ts";

// A stored Lens capture, written in SQL as pi_admin, for the rules that read knowledge.captures
// alone: a moment as the seeder writes it, or a meeting, with a calendar entry of the UID given or
// with none. The meeting is the seeder's moment turned into one: its kind, its key and its sealed
// facts. Synthetic values only.
export async function seedCapture(
  db: TestDatabase,
  compartments: string[],
  kind: "moment" | "meeting",
  calendarUid?: string,
): Promise<CaptureId> {
  return session(db.urls.admin, async (query) => {
    const { id, key } = await seeder(db, query).capture(compartments);
    if (kind === "moment") return id as CaptureId;
    const facts: CaptureFacts = {
      kind: "meeting",
      app: { bundle: "test.seed.call", name: "Seed Call" },
      title: null,
      account: null,
      host: null,
      consent: true,
      mode: "call",
      series: null,
      part: null,
      calendar: calendarUid === undefined ? null : { title: null, uid: calendarUid, organizer: null, attendees: [] },
      speakers: [],
      linked: null,
      counts: { segments: 0, chars: 0, minutes: 0, blanked: 0 },
    };
    const at = { table: "knowledge.captures", id, column: "facts_enc" };
    await query("update knowledge.captures set kind = 'meeting', capture_key = $2, facts_enc = $3 where id = $1", [
      id,
      `meeting:${key.slice("moment:".length)}`,
      sealRow(db.keys, compartments[0] ?? "own", at, JSON.stringify(facts)),
    ]);
    return id as CaptureId;
  });
}

// A recorded meeting as the drain stores one, written in SQL as pi_admin, for the reads of a meeting's
// text: its blob, the item's JSON in base64 sealed under the label; its evidence row of kind
// transcript; its capture row citing it, with its facts. One synthetic line said by the owner.
// `account`: the device's meetings account, a new device's when left out.
export async function seedMeeting(
  db: TestDatabase,
  compartments: string[],
  line: string,
  account?: string,
): Promise<{ id: CaptureId; evidenceId: string; account: string }> {
  return session(db.urls.admin, async (query) => {
    const source = account ?? (await seeder(db, query).lensDevice()).accounts.meeting;
    const key = `meeting:${testId("k").slice(2)}`;
    const at = { startedAt: "2026-01-05T10:00:00.000Z", endedAt: "2026-01-05T10:30:00.000Z" };
    const app = { bundle: "test.seed.call", name: "Seed Call" };
    const item = {
      kind: "meeting",
      key,
      revision: 0,
      ...at,
      app,
      consent: true,
      mode: "call",
      speakers: [{ label: "S1", owner: true }],
      segments: [{ speaker: "S1", fromMs: 0, toMs: 5_000, channel: "input", text: line }],
    };
    const facts: CaptureFacts = {
      kind: "meeting",
      app,
      title: "Seed review",
      account: null,
      host: null,
      consent: true,
      mode: "call",
      series: null,
      part: null,
      calendar: null,
      speakers: [{ label: "S1", owner: true, mention: null }],
      linked: null,
      counts: { segments: 1, chars: line.length, minutes: 0, blanked: 0 },
    };
    const label = compartments[0] ?? "own";
    const sealed = (table: string, id: string, column: string, value: string) =>
      sealRow(db.keys, label, { table, id, column }, value);
    const blob = testId("blb");
    await query("insert into vault.evidence_blobs (blob_ref, compartments, envelope) values ($1, $2, $3)", [
      blob,
      compartments,
      sealed("vault.evidence_blobs", blob, "envelope", Buffer.from(JSON.stringify(item)).toString("base64")),
    ]);
    const where = { vault: "personal" as const, sourceAccount: SourceAccountId.parse(source), sourceItemId: key };
    const evidenceId = evidenceIdFor({ ...where, revision: 0 });
    await query(
      `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision,
         next_revision_id, content_hash, media_type, observed_at, change_kind, participant_members, system_originated,
         answers_system, payload_state, compartments, readers, blob_ref, item_enc)
       values ($1, $2, 'transcript', $3, $4, 0, $5, $6, 'application/json', $7, 'live', '{m-owner}', false, false,
         'present', $8, '{m-owner}', $9, $10)`,
      [
        evidenceId,
        source,
        fingerprint(db.keys, "source_id", key),
        fingerprint(db.keys, "revision_tag", `h:${key}`),
        evidenceIdFor({ ...where, revision: 1 }),
        hashFingerprint(db.keys, "content_hash", sha256Hex(`seed meeting ${key}`)),
        at.startedAt,
        compartments,
        blob,
        sealed("vault.evidence_items", evidenceId, "item_enc", JSON.stringify(facts)),
      ],
    );
    const id = testId("cap") as CaptureId;
    await query(
      `insert into knowledge.captures (id, evidence_id, source_account_id, capture_key, compartments, kind, revision,
         started_at, ended_at, first_pushed_at, local_day, facts_enc)
       values ($1, $2, $3, $4, $5, 'meeting', 0, $6, $7, $7, $8, $9)`,
      [
        id,
        evidenceId,
        source,
        key,
        compartments,
        at.startedAt,
        at.endedAt,
        at.startedAt.slice(0, 10),
        sealed("knowledge.captures", id, "facts_enc", JSON.stringify(facts)),
      ],
    );
    return { id, evidenceId, account: source };
  });
}
