import {
  CaptureWork,
  ClaimRecord,
  ClientRegistration,
  isCanaryClient,
  LensDeviceView,
  MacContactDrop,
  MacContactsView,
  MIRROR_QUOTA,
  type MomentCaptureFacts,
  type PersonalCompartment,
  type PersonalView,
  QUOTA_DEFAULTS,
  RESTRICTED_PREFIX,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { byText, type Query, stamp, stampOrNull } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import type { Keys } from "../../core/keys.ts";
import { CAPTURE_KINDS, CAPTURE_LANES } from "../../core/lanes.ts";
import { TRY_SYNC } from "../../core/locks.ts";
import { open, type Sealed, sealUnder } from "../../core/seal.ts";
import { OWNER_ENTITY } from "../../core/statements.ts";
import { deviceLabel } from "../../core/stored-forms.ts";
import { openedUnder, type Tx } from "../../core/tx.ts";
import { reaskMoments } from "../../lens/capture-contacts.ts";
import { rewriteCaptureItem } from "../../lens/capture-item.ts";
import { peopleMadeByName } from "../../write/participant-binding.ts";
import { removeSourceItem } from "../../write/writer-item-removal.ts";
import { capped, newToken, rotated } from "../admin-base.ts";
import { quotaValues } from "../clients/admin-quota.ts";
import { tryExtractLock } from "../extraction/admin-extraction.ts";
import { replayMoments } from "../projects/admin-projects.ts";

// `pi lens add`, `rotate`, `revoke` and `list`, as pi_admin. A
// device's capture token is returned once by `add` and stored only hashed; its mirror token is
// issued only by the first `rotate --mirror`, so a mirror token is never live before Lens's
// mirror reader is given one. `revokeDevice` ends the mirror client's rows and `devices()`
// reads the mirror's counts.

// The codes the push answers for one item. The inbox holds a code only once
// the drain has set it, so of these only `out_of_scope` (checked again at drain) is ever counted;
// every other code is the drain's own, and counted as dropped.
const PUSH_CODES: readonly string[] = ["out_of_scope", "conflict", "out_of_order", "ceiling"];

// The explicit_self claims of a device's meetings and moments, by day, over the last
// seven days.
const OWN_WORDS_DAYS = 7;

// Both clients, the device row and the three accounts, in one transaction. The
// mirror's compartments are checked as `pi clients add` checks them, and a restricted one is
// refused `restricted_not_served`. The mirror client is stored with the hash of a token made
// and dropped at once, which no caller ever holds: it answers nothing until `rotateDevice(name,
// "mirror")` gives it a token. Throws AdminError "restricted_not_served", "invalid_registration" or
// "duplicate_name".
// The owner's add: a `canary-` name is the standing check's, whose setup calls `addDevice` itself.
export function addOwnerDevice(
  admin: AdminContext,
  name: string,
  options: { compartments: PersonalCompartment[]; views: PersonalView[] },
): Promise<{ capture: string }> {
  if (isCanaryClient(name)) return Promise.reject(new AdminError("invalid_registration"));
  return addDevice(admin, name, options);
}

export async function addDevice(
  admin: AdminContext,
  name: string,
  options: { compartments: PersonalCompartment[]; views: PersonalView[] },
): Promise<{ capture: string }> {
  if (options.compartments.some((compartment) => compartment.startsWith(RESTRICTED_PREFIX)))
    throw new AdminError("restricted_not_served");
  const capture = ClientRegistration.safeParse({
    name: `${name}-capture`,
    runtime: "local",
    vendorRetention: "none",
    kind: "device",
    idMode: "stable",
    quota: QUOTA_DEFAULTS.device,
    compartments: ["own"],
    views: ["self"],
    tools: ["push_capture"],
  });
  // Retention none, and stable ids passed explicitly, so a later change of the
  // retention never changes the ids.
  const mirror = ClientRegistration.safeParse({
    name,
    runtime: "local",
    vendorRetention: "none",
    kind: "agent",
    idMode: "stable",
    quota: MIRROR_QUOTA,
    compartments: options.compartments,
    views: options.views,
    tools: ["sync_mirror"],
  });
  if (!capture.success || !mirror.success) throw new AdminError("invalid_registration");
  const mirrorCompartments = capped(mirror.data.compartments);
  const tokens = { capture: newToken(), mirror: newToken() };
  const created = stamp(admin.now());
  await admin.transaction(async (query) => {
    const insert = async (registration: ClientRegistration, compartments: string[], hash: string): Promise<string> => {
      const [row] = await query<{ id: string }>(
        `insert into policy.clients (id, name, token_hash, vendor_retention, runtime, compartments, views, tools, created_at, kind, id_mode,
           max_items_day, max_chars_day, max_rows_day, max_calls_minute)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         on conflict (name) do nothing returning id`,
        [
          newId("cli"),
          registration.name,
          hash,
          registration.vendorRetention,
          registration.runtime,
          compartments,
          registration.views,
          registration.tools,
          created,
          registration.kind,
          registration.idMode,
          ...quotaValues(registration.quota ?? QUOTA_DEFAULTS.agent),
        ],
      );
      if (row === undefined) throw new AdminError("duplicate_name");
      return row.id;
    };
    const captureId = await insert(capture.data, ["own"], tokens.capture.hash);
    const mirrorId = await insert(mirror.data, mirrorCompartments, tokens.mirror.hash);
    const [device] = await query(
      "insert into policy.lens_devices (name, capture_client_id, mirror_client_id, created_at) values ($1, $2, $3, $4) on conflict (name) do nothing returning name",
      [name, captureId, mirrorId, created],
    );
    if (device === undefined) throw new AdminError("duplicate_name");
    for (const { connector, source } of CAPTURE_KINDS.map((kind) => CAPTURE_LANES[kind])) {
      await query(
        "insert into vault.source_accounts (id, label, connector, source_kind, compartments, address_fp, address_enc) values ($1, $2, $3, $4, '{own}', null, null)",
        [newId("acc"), deviceLabel(name), connector, source],
      );
    }
  });
  return { capture: tokens.capture.token };
}

// Both clients revoked by one statement, in one transaction; a client already revoked
// stays as it was. The inbox rows the device pushed stay, to be drained and settled. The mirror
// client's live rows are ended `withdrawn` in the same transaction, by ledger.end_mirror. Throws
// AdminError "not_found" for a name no device has.
export async function revokeDevice(admin: AdminContext, name: string): Promise<void> {
  const found = await admin.transaction(async (query) => {
    const [device] = await query<{ capture_client_id: string; mirror_client_id: string }>(
      "select capture_client_id, mirror_client_id from policy.lens_devices where name = $1 for update",
      [name],
    );
    if (device === undefined) return false;
    await query(
      "update policy.clients set status = 'revoked', revoked_at = $2 where id = any ($1) and status = 'active'",
      [[device.capture_client_id, device.mirror_client_id], stamp(admin.now())],
    );
    await query("select ledger.end_mirror($1)", [device.mirror_client_id]);
    return true;
  });
  if (!found) throw new AdminError("not_found");
}

// rotateToken for one channel: a new token for the device's capture or mirror client, and
// every OAuth token of that client revoked in the same transaction, so no other credential of the
// channel outlives the rotation. The mirror channel's first rotation is what issues
// its first token. Throws AdminError "not_found" for an unknown device or a
// revoked client.
export async function rotateDevice(admin: AdminContext, name: string, channel: "capture" | "mirror"): Promise<string> {
  const token = await admin.transaction(async (query) => {
    const [client] = await query<{ id: string; name: string }>(
      `select c.id, c.name from policy.lens_devices d join policy.clients c on c.id = (case when $2 = 'capture' then d.capture_client_id else d.mirror_client_id end) where d.name = $1`,
      [name, channel],
    );
    if (client === undefined) return null;
    const made = await rotated(query, client.name);
    if (made !== null) await query("select ledger.revoke_device_oauth($1)", [client.id]);
    return made;
  });
  if (token === null) throw new AdminError("not_found");
  return token;
}

type DeviceRow = { name: string; capture: string; mirror: string; active: boolean; last_push_at: Date | null };
type CodeRow = { client_id: string; code: string; n: number };
export type LabelRow = { label: string; id: string; compartments: string[]; value_enc: Sealed };

// A sealed value opened under the admin's keys, or null when the key file lacks a key of its label,
// holds a wrong one, or the value is no JSON: `pi status` names a key that is absent or wrong
// already, and a count leaves the row out rather than fail the command.
export function parsedOrNull(keys: Keys, table: string, column: string, row: LabelRow): unknown {
  if (!row.compartments.every((compartment) => keys.compartments.has(compartment))) return null;
  try {
    return JSON.parse(openedUnder(keys, row.compartments, { table, id: row.id, column }, row.value_enc)) as unknown;
  } catch {
    return null;
  }
}

const blankedOf = (facts: unknown): number => {
  const blanked = (facts as { counts?: { blanked?: unknown } } | null)?.counts?.blanked;
  return typeof blanked === "number" && Number.isInteger(blanked) && blanked > 0 ? blanked : 0;
};

type Days = Map<string, Map<string, number>>;
// One more on a device's day.
const tally = (days: Days, label: string, day: string): void => {
  const of = days.get(label) ?? new Map<string, number>();
  of.set(day, (of.get(day) ?? 0) + 1);
  days.set(label, of);
};
// A device's days in text order.
const byDay = (days: Map<string, number> | undefined): { day: string; count: number }[] =>
  [...(days ?? new Map<string, number>())].sort(([a], [b]) => byText(a, b)).map(([day, count]) => ({ day, count }));

// What `devices` reads, its statements in one fixed order: clear counts, and the sealed rows it
// opens under the admin's keys.
async function deviceReadsOf(query: Query, from: string, to: string) {
  return {
    rows: await query<DeviceRow>(
      `select d.name, d.capture_client_id as capture, d.mirror_client_id as mirror, (c.status = 'active' and m.status = 'active') as active,
         (select max(k.at) from policy.calls k where k.client_id = d.capture_client_id and k.tool = 'push_capture') as last_push_at
       from policy.lens_devices d
       join policy.clients c on c.id = d.capture_client_id
       join policy.clients m on m.id = d.mirror_client_id
       order by d.name collate "C"`,
    ),
    waiting: await query<{ client_id: string; waiting: number; forgets: number }>(
      `select client_id,
         count(*) filter (where kind not in ('forget', 'contact', 'contacts') and body_enc is not null and evidence_id is null and refused_code is null)::int as waiting,
         count(*) filter (where kind = 'forget' and body_enc is not null and taken_at is null)::int as forgets
       from ledger.capture_inbox group by client_id`,
    ),
    // Each mirror client's live rows, those whose state as sent the Mac has not
    // confirmed, and its last completed pass: last_completed_at, carried on every cursor, so it
    // holds while the next pass runs.
    mirrors: await query<{ client_id: string; live: number; unconfirmed: number; last_pass_at: Date | null }>(
      `select d.mirror_client_id as client_id,
         (select count(*) from ledger.mirror_entries e where e.client_id = d.mirror_client_id and e.ended_at is null)::int as live,
         (select count(*) from ledger.mirror_entries e where e.client_id = d.mirror_client_id and e.ended_at is null and e.confirmed_state is distinct from e.sent_state)::int as unconfirmed,
         (select max(c.last_completed_at) from ledger.mirror_cursors c where c.client_id = d.mirror_client_id) as last_pass_at
       from policy.lens_devices d`,
    ),
    // A Mac contact's or a listing's codes are macContacts', counted there alone.
    codes: await query<CodeRow>(
      "select client_id, refused_code as code, count(*)::int as n from ledger.capture_inbox where refused_code is not null and kind not in ('contact', 'contacts') group by client_id, refused_code order by refused_code collate \"C\"",
    ),
    meetings: await query<LabelRow>(
      `select a.label, cp.id, cp.compartments, cp.facts_enc as value_enc
       from knowledge.captures cp join vault.source_accounts a on a.id = cp.source_account_id
       where a.connector = 'lens_meetings' and cp.kind = 'meeting'`,
    ),
    claims: await query<LabelRow & { day: string }>(
      `select a.label, cp.local_day::text as day, c.id, c.compartments, c.content_enc as value_enc
       from knowledge.claims c
       join knowledge.captures cp on cp.evidence_id = c.evidence_id
       join vault.source_accounts a on a.id = cp.source_account_id
       where ((a.connector = 'lens_meetings' and cp.kind = 'meeting') or (a.connector = 'lens_activity' and cp.kind = 'moment'))
         and cp.local_day between $1::date and $2::date`,
      [from, to],
    ),
    // Each device's activity claims, by the UTC day of their
    // valid_from: a type in clear, counted, nothing opened.
    activity: await query<{ label: string; day: string; n: number }>(
      `select a.label, (c.valid_from at time zone 'utc')::date::text as day, count(*)::int as n
       from knowledge.claims c
       join knowledge.captures cp on cp.evidence_id = c.evidence_id
       join vault.source_accounts a on a.id = cp.source_account_id
       where starts_with(c.type, 'activity.') and a.connector in ('lens_meetings', 'lens_activity', 'lens_blocks')
         and c.valid_from >= ($1::date)::timestamp at time zone 'UTC' and c.valid_from < ($2::date + 1)::timestamp at time zone 'UTC'
       group by a.label, 2
       order by 2`,
      [from, to],
    ),
    // The people its meetings made by a name alone.
    made: await peopleMadeByName(query, from),
    // Each device's source moments stored, and those the drain dropped, by
    // code: the source in clear on the capture and the inbox row, nothing opened.
    sourceStored: await query<{ label: string; n: number }>(
      `select a.label, count(*)::int as n from knowledge.captures cp join vault.source_accounts a on a.id = cp.source_account_id
       where cp.source is not null group by a.label`,
    ),
    sourceDropped: await query<CodeRow>(
      `select client_id, refused_code as code, count(*)::int as n from ledger.capture_inbox
       where source is not null and refused_code is not null group by client_id, refused_code order by refused_code collate "C"`,
    ),
    // Each device's Mac contacts' switch, those stored and the inbox rows the
    // drain dropped, by code: clear columns, nothing opened.
    macContacts: await macContactsOf(query),
    // Each device's stored task events, by the day (UTC) they were recorded on.
    tasks: await query<LabelRow>(
      `select a.label, cp.id, cp.compartments, cp.work_enc as value_enc
       from knowledge.captures cp join vault.source_accounts a on a.id = cp.source_account_id
       where a.connector = 'lens_tasks' and cp.kind = 'task' and cp.work_enc is not null and cp.ended_at >= $1::date`,
      [from],
    ),
    owner: (await query<{ id: string }>(OWNER_ENTITY))[0]?.id,
  };
}
type DeviceReads = Awaited<ReturnType<typeof deviceReadsOf>>;
type Opened = { taskEvents: Days; blanked: Map<string, number>; ownWords: Days };

// One device's view, from what `devices` read and opened.
function deviceView(row: DeviceRow, reads: DeviceReads, opened: Opened): LensDeviceView {
  const waiting = reads.waiting.find((one) => one.client_id === row.capture);
  const mirror = reads.mirrors.find((one) => one.client_id === row.mirror);
  const mine = reads.codes.filter((one) => one.client_id === row.capture);
  const label = deviceLabel(row.name);
  return LensDeviceView.parse({
    name: row.name,
    capture: row.capture,
    mirror: row.mirror,
    status: row.active ? "active" : "revoked",
    inbox: {
      waiting: waiting?.waiting ?? 0,
      forgetsWaiting: waiting?.forgets ?? 0,
      refused: Object.fromEntries(mine.filter((one) => PUSH_CODES.includes(one.code)).map((one) => [one.code, one.n])),
      dropped: Object.fromEntries(mine.filter((one) => !PUSH_CODES.includes(one.code)).map((one) => [one.code, one.n])),
    },
    blankedSegments: opened.blanked.get(label) ?? 0,
    lastPushAt: stampOrNull(row.last_push_at),
    lastPassAt: stampOrNull(mirror?.last_pass_at ?? null),
    mirrorEntries: mirror?.live ?? 0,
    unconfirmed: mirror?.unconfirmed ?? 0,
    ownWords: byDay(opened.ownWords.get(label)),
    taskEvents: byDay(opened.taskEvents.get(label)),
    activity: reads.activity.filter((one) => one.label === label).map((one) => ({ day: one.day, count: one.n })),
    peopleMade: reads.made.filter((one) => one.label === label).map((one) => ({ day: one.day, count: one.n })),
    sourceMoments: {
      stored: reads.sourceStored.find((one) => one.label === label)?.n ?? 0,
      dropped: Object.fromEntries(
        reads.sourceDropped.filter((one) => one.client_id === row.capture).map((one) => [one.code, one.n]),
      ),
    },
    ...(reads.macContacts.has(row.name) ? { macContacts: reads.macContacts.get(row.name) } : {}),
  });
}

// Each device by name, as LensDeviceView: ids, codes, counts and times, and no name,
// title, URL or host. The blanked segments and the explicit_self claims are sealed, so they are
// opened under the admin's keys: the blanked counts of the device's meetings, and only the
// claims of its meetings and moments of the last seven days.
export async function devices(admin: AdminContext): Promise<LensDeviceView[]> {
  const today = new Date(Math.floor(admin.now().getTime() / DAY_MS) * DAY_MS);
  const from = new Date(today.getTime() - (OWN_WORDS_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);
  return admin.transaction(async (query: Query) => {
    const reads = await deviceReadsOf(query, from, to);
    const taskEvents: Days = new Map();
    for (const row of reads.tasks) {
      const work = CaptureWork.safeParse(parsedOrNull(admin.keys, "knowledge.captures", "work_enc", row));
      if (!work.success || work.data.kind !== "task") continue;
      for (const event of work.data.events) {
        const day = new Date(event.at).toISOString().slice(0, 10);
        if (day >= from && day <= to) tally(taskEvents, row.label, day);
      }
    }
    const blanked = new Map<string, number>();
    for (const row of reads.meetings) {
      const facts = parsedOrNull(admin.keys, "knowledge.captures", "facts_enc", row);
      blanked.set(row.label, (blanked.get(row.label) ?? 0) + blankedOf(facts));
    }
    // A moment credits a participant's own statement explicit_self too, so the count is of the
    // owner's own word: explicit_self and credited to the owner.
    const ownWords: Days = new Map();
    for (const row of reads.claims) {
      const record = ClaimRecord.safeParse(parsedOrNull(admin.keys, "knowledge.claims", "content_enc", row));
      const own = record.success && record.data.claim.basis === "explicit_self";
      if (own && record.data.claim.assertedBy === reads.owner) tally(ownWords, row.label, row.day);
    }
    return reads.rows.map((row) => deviceView(row, reads, { taskEvents, blanked, ownWords }));
  });
}

// Work time: the device's `lens_tasks` account, made if it lacks one, as pi_admin. Safe to repeat:
// (label, connector) is unique.
export async function ensureTasksAccount(query: Query, name: string): Promise<void> {
  await query(
    `insert into vault.source_accounts (id, label, connector, source_kind, compartments, address_fp, address_enc)
     values ($1, $2, 'lens_tasks', 'owner_task', '{own}', null, null) on conflict (label, connector) do nothing`,
    [newId("acc"), deviceLabel(name)],
  );
}

// Work time: `pi lens tasks NAME on|off`, the device's switch for its
// task items; `on` makes the device's lens_tasks account first if it has none, in the same
// transaction. Throws AdminError "not_found" for no such device.
export async function setDeviceTasks(admin: AdminContext, name: string, on: boolean): Promise<void> {
  const found = await admin.transaction(async (query: Query) => {
    const updated = await query<{ name: string }>(
      "update policy.lens_devices set tasks = $2 where name = $1 returning name",
      [name, on],
    );
    if (updated.length === 0) return false;
    if (on) await ensureTasksAccount(query, name);
    return true;
  });
  if (!found) throw new AdminError("not_found");
}

// The device's source moments stored already whose revision was pushed inside it are vouched in the same
// transaction: their facts, sealed in the capture row and the evidence row, gain the mark, and they are
// set waiting with their saved calls kept, widened to their saved calls' and groups' other members as
// the re-check widens (replayMoments), so the next run replays them at no model cost and credits the
// owner's lines; a withheld or a restricted moment is not set waiting, nor one that failed with no saved
// call. The window starts at the first source moment stored. Refused `not_found` for no such device or
// no source moment pushed yet, `already_settled` once vouched (the database holds it too),
// `sync_running` while a sync holds its lock (so no drain seals a revision of the window between this
// read and its commit), and `extract_running` while a run holds the extract lock. Times and a count
// only.
const VOUCH_WINDOW_MS = 48 * 3_600_000;
export async function vouchBackfill(
  admin: AdminContext,
  name: string,
): Promise<{ from: string; to: string; moments: number }> {
  return admin.transaction(async (query: Query) => {
    const tx: Tx = { query, keys: admin.keys };
    const [sync] = await query<{ held: boolean }>(TRY_SYNC);
    if (sync?.held !== true) throw new AdminError("sync_running");
    await tryExtractLock(tx);
    const [device] = await query<{ capture: string; vouched: boolean }>(
      "select capture_client_id as capture, backfill_vouched_at is not null as vouched from policy.lens_devices where name = $1 for update",
      [name],
    );
    if (device === undefined) throw new AdminError("not_found");
    if (device.vouched) throw new AdminError("already_settled");
    const label = deviceLabel(name);
    const [first] = await query<{ at: Date | null }>(
      `select least(
         (select min(received_at) from ledger.capture_inbox where client_id = $1 and source is not null and evidence_id is not null),
         (select min(c.first_pushed_at) from knowledge.captures c join vault.source_accounts a on a.id = c.source_account_id
          where a.label = $2 and a.connector = 'lens_activity' and c.source is not null)) as at`,
      [device.capture, label],
    );
    if (first?.at === null || first?.at === undefined) throw new AdminError("not_found");
    const from = first.at;
    const to = new Date(from.getTime() + VOUCH_WINDOW_MS);
    await query(
      "update policy.lens_devices set backfill_vouch_from = $2, backfill_vouch_to = $3, backfill_vouched_at = $4 where name = $1",
      [name, from, to, stamp(admin.now())],
    );
    const rows = await query<{
      id: string;
      compartments: string[];
      facts_enc: Sealed;
      evidence_id: string;
      item_compartments: string[];
      item_enc: Sealed;
    }>(
      `select c.id, c.compartments, c.facts_enc, c.evidence_id, e.compartments as item_compartments, e.item_enc
       from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id join vault.source_accounts a on a.id = c.source_account_id
       where a.label = $1 and a.connector = 'lens_activity' and c.kind = 'moment' and c.source is not null and not policy.is_restricted(c.compartments)
       order by c.id for update of c, e`,
      [label],
    );
    const inside = (facts: MomentCaptureFacts): boolean =>
      facts.pushedAt !== undefined &&
      Date.parse(facts.pushedAt) >= from.getTime() &&
      Date.parse(facts.pushedAt) <= to.getTime();
    const vouched: string[] = [];
    for (const row of rows) {
      const at = { table: "knowledge.captures", id: row.id, column: "facts_enc" };
      const facts = JSON.parse(open(admin.keys, row, "knowledge.captures.facts_enc", "throw")) as MomentCaptureFacts;
      if (facts.source === undefined || facts.vouched === true || !inside(facts)) continue;
      await query("update knowledge.captures set facts_enc = $2 where id = $1", [
        row.id,
        sealUnder(admin.keys, row.compartments, at, JSON.stringify({ ...facts, vouched: true })),
      ]);
      const item = JSON.parse(
        open(
          admin.keys,
          { id: row.evidence_id, compartments: row.item_compartments, item_enc: row.item_enc },
          "vault.evidence_items.item_enc",
          "throw",
        ),
      ) as MomentCaptureFacts;
      await rewriteCaptureItem(
        query,
        admin.keys,
        { evidenceId: row.evidence_id, compartments: row.item_compartments },
        { ...item, vouched: true },
      );
      vouched.push(row.evidence_id);
    }
    if (vouched.length > 0) await replayMoments(tx, vouched);
    return { from: from.toISOString(), to: to.toISOString(), moments: vouched.length };
  });
}

// A device's Mac contacts.

// The device's `lens_contacts` account, made if it lacks one, as pi_admin, as ensureTasksAccount
// makes its tasks' (pi_owner may only select source accounts, so no migration makes it). Safe to
// repeat: (label, connector) is unique.
async function ensureContactsAccount(query: Query, name: string): Promise<void> {
  await query(
    `insert into vault.source_accounts (id, label, connector, source_kind, compartments, address_fp, address_enc)
     values ($1, $2, 'lens_contacts', 'crm', '{own}', null, null) on conflict (label, connector) do nothing`,
    [newId("acc"), deviceLabel(name)],
  );
}

type MacContactsRow = { name: string; on: boolean; stored: number };
// Each device's switch and its stored Mac contacts, and its contact and listing rows dropped, by
// code: counts and codes only.
async function macContactsOf(query: Query, name?: string): Promise<Map<string, Omit<MacContactsView, "device">>> {
  const rows = await query<MacContactsRow>(
    `select d.name, d.contacts as on,
       (select count(*)::int from knowledge.contacts c join vault.source_accounts a on a.id = c.account_id
        where a.connector = 'lens_contacts' and a.label = 'device:' || d.name) as stored
     from policy.lens_devices d where $1::text is null or d.name = $1`,
    [name ?? null],
  );
  const codes = await query<{ name: string; code: string; n: number }>(
    `select d.name, i.refused_code as code, count(*)::int as n from ledger.capture_inbox i join policy.lens_devices d on d.capture_client_id = i.client_id
     where i.kind in ('contact', 'contacts') and i.refused_code is not null and ($1::text is null or d.name = $1)
     group by d.name, i.refused_code order by i.refused_code collate "C"`,
    [name ?? null],
  );
  return new Map(
    rows.map((row) => [
      row.name,
      {
        on: row.on,
        stored: row.stored,
        dropped: Object.fromEntries(
          codes
            .filter((one) => one.name === row.name && MacContactDrop.safeParse(one.code).success)
            .map((one) => [one.code, one.n]),
        ),
      },
    ]),
  );
}

// Throws AdminError "not_found".
export async function deviceContacts(admin: AdminContext, name: string): Promise<MacContactsView> {
  const view = await admin.transaction(async (query: Query) => (await macContactsOf(query, name)).get(name));
  if (view === undefined) throw new AdminError("not_found");
  return MacContactsView.parse({ device: name, ...view });
}

// `on` makes the device's lens_contacts account first if it has none. `off` removes every Mac
// contact of the device through the deletion path, since with pushes refused no later listing
// could; it takes the sync lock first, as every deletion does, and is refused `sync_running` while
// a sync holds it, and the extraction lock, refused `extract_running`, since the source moments the
// removed contacts' phones name are set due again in the same transaction. Returns how many it
// removed. Throws AdminError "not_found" for no such device.
export async function setDeviceContacts(admin: AdminContext, name: string, on: boolean): Promise<{ removed: number }> {
  return admin.transaction(async (query: Query) => {
    if (!on && (await query<{ held: boolean }>(TRY_SYNC))[0]?.held !== true) throw new AdminError("sync_running");
    if (!on) await tryExtractLock({ query, keys: admin.keys });
    const updated = await query<{ name: string }>(
      "update policy.lens_devices set contacts = $2 where name = $1 returning name",
      [name, on],
    );
    if (updated.length === 0) throw new AdminError("not_found");
    if (on) {
      await ensureContactsAccount(query, name);
      return { removed: 0 };
    }
    // The account is under `own` alone (source_accounts_lens).
    const [account] = await query<{ id: string }>(
      "select id from vault.source_accounts where label = $1 and connector = 'lens_contacts'",
      [deviceLabel(name)],
    );
    if (account === undefined) return { removed: 0 };
    const items = await query<{ source_item_fp: string }>(
      "select distinct source_item_fp from vault.evidence_items where source_account_id = $1 order by 1",
      [account.id],
    );
    const phones = new Set(
      (
        await query<{ fp: string }>(
          "select distinct unnest(coalesce(phone_fps, '{}')) as fp from knowledge.contacts where account_id = $1",
          [account.id],
        )
      ).map((row) => row.fp),
    );
    let removed = 0;
    for (const item of items) {
      const gone = await removeSourceItem(
        { query, keys: admin.keys },
        { id: account.id, compartment: "own" },
        item.source_item_fp,
        // The owner switched the Mac's contacts off; only switching them on stores it again.
        "dropped",
      );
      if (gone.removed) removed += 1;
    }
    await reaskMoments({ query, keys: admin.keys }, phones);
    return { removed };
  });
}
