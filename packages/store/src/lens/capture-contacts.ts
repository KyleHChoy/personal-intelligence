import type { RawItem, Timestamp } from "@intelligence/contracts";
import {
  isCoded,
  type MacContactDrop,
  MacContactItem,
  MacContactsListed,
  type MomentCaptureFacts,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS, phoneKey } from "@intelligence/personal-core";
import {
  contactKept,
  deriveItem,
  type ItemContext,
  type ItemFacts,
  macContactItem,
  macContactItemId,
} from "@intelligence/personal-core/items";
import { systemIdIn } from "@intelligence/personal-core/lens";
import { fingerprint } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";
import { TRY_EXTRACT } from "../core/locks.ts";
import { open, type Sealed } from "../core/seal.ts";
import { sql } from "../core/sql.ts";
import type { Tx } from "../core/tx.ts";
import { SOURCE_MOMENT } from "../core/vocabulary.ts";
import { ownerAddresses } from "../identity/identity-port.ts";
import { momentPhonesOf } from "../write/participant-binding.ts";
import { type RemovalReason, removeSourceItem } from "../write/writer-item-removal.ts";
import type { IngestAnswer, SourceAccountRow } from "../write/writer-types.ts";
import type { DrainContext } from "./capture-drain.ts";
import { readInbox } from "./inbox-body.ts";

// The Mac contacts Lens sent, out of the inbox and into the contacts writer as saved contacts of
// the device's `lens_contacts` account, by `pi sync` as pi_writer, after takeCapture and before the
// participant step, under the sync lock. Each name, phone and email is untrusted data, checked for
// form and never followed.
//
// A contact row goes through three states: untaken; decided (its revision ingested, its
// `evidence_id` set, or dropped, its `refused_code` set), body kept, while the re-ask its phones
// need is owed; taken (`taken_at` set, body null). A row whose decision needs no re-ask is taken at
// once. The listings are applied, and every owed row taken, in one transaction under the extraction
// lock with the re-ask itself, so a moment the lock would refuse is never left
// behind: when the lock is held elsewhere, nothing of that step is written and the next run does
// it.

export type ContactsTaken = {
  stored: number;
  unchanged: number;
  removed: number;
  momentsDue: number;
  dropped: Partial<Record<MacContactDrop, number>>;
  failed: number;
  waiting: number;
};

type ContactsContext = DrainContext & {
  ingest(
    account: SourceAccountRow,
    raw: RawItem,
    derive: (ctx: ItemContext) => Promise<ItemFacts>,
  ): Promise<IngestAnswer>;
  now(): Date;
};

type Row = {
  id: string;
  client_id: string;
  kind: string;
  revision: number;
  content_fp: string;
  body_enc: Sealed | null;
  evidence_id: string | null;
  refused_code: string | null;
  received_at: Date;
};
const ROW =
  "select id, client_id, kind, revision, content_fp, body_enc, evidence_id, refused_code, received_at from ledger.capture_inbox";
// The untaken rows of a kind, oldest first: those not yet decided, and (for contacts) those decided
// whose re-ask is owed.
const UNTAKEN = `${ROW} where kind = $1 and taken_at is null and body_enc is not null`;
const FRESH = `${UNTAKEN} and evidence_id is null and refused_code is null order by received_at, id limit $2`;
const OWED = `${UNTAKEN} and (evidence_id is not null or refused_code is not null) order by received_at, id limit $2`;
const DEVICE = `
  select d.name, d.contacts as on, a.id as account_id from policy.lens_devices d
  left join vault.source_accounts a on a.label = 'device:' || d.name and a.connector = 'lens_contacts'
  where d.capture_client_id = $1`;
const OUTRANKED = `
  select exists (
    select 1 from knowledge.contacts c
    where c.phone_fps @> array[$1]::text[] and c.compartments <@ array['own'] and cardinality(c.address_fps) > 0
      and not (c.address_fps <@ array[$2]::text[]) and not (c.account_id = $3 and c.source_contact_fp = $4)
  ) or exists (
    select 1 from knowledge.mention_bindings b join knowledge.captures p on p.evidence_id = b.evidence_id
    where b.origin = 'owner' and b.lifted_at is null and b.mention_fp = $5 and p.source is not null
  ) as outranked`;
const PHONE_ONLY = `
  select c.account_id, c.source_contact_fp, a.compartments from knowledge.contacts c join vault.source_accounts a on a.id = c.account_id
  where a.connector = 'lens_contacts' and cardinality(c.address_fps) = 1 and c.address_fps <@ $1::text[]
    and not (c.account_id = $2 and c.source_contact_fp = $3)
  order by c.id`;
const PHONES_OF =
  "select coalesce(phone_fps, '{}') as phone_fps from knowledge.contacts where account_id = $1 and source_contact_fp = $2";
const LATEST =
  "select id, observed_at from vault.evidence_items where source_account_id = $1 and source_item_fp = $2 order by revision desc limit 1";
const SOURCE_MOMENTS = sql`
  select c.id, c.evidence_id, c.compartments, c.facts_enc from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id
  where ${SOURCE_MOMENT} and e.payload_state = 'present'
  order by c.started_at desc, c.id collate "C"`;

const phoneFp = (keys: Keys, phone: string): string => fingerprint(keys, "phone", phone);
const telFp = (keys: Keys, phone: string): string | null => {
  const key = phoneKey(phone);
  return key === null ? null : fingerprint(keys, "address", key);
};
// Whether a Mac contact's raw item is keyed by an address: an email the strict reading kept, not
// the phone key it falls back to.
const emailed = (raw: RawItem): boolean =>
  raw.permissions.scope === "listed" && raw.permissions.identifiers.some((one) => !one.startsWith("tel:"));
const add = (counts: ContactsTaken, code: MacContactDrop): void => {
  counts.dropped[code] = (counts.dropped[code] ?? 0) + 1;
};

// A row's body, opened under `own` and checked against its content fingerprint; null for one that
// does not open (a key missing: it waits), "invalid" for one that does not match or parse.
function bodyOf<T>(
  tx: Tx,
  row: Row,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T | "invalid" | null {
  let read: ReturnType<typeof readInbox>;
  try {
    read = readInbox(tx.keys, row);
  } catch {
    return null;
  }
  if (typeof read === "string") return "invalid";
  const parsed = schema.safeParse(read.raw);
  if (!parsed.success) return "invalid";
  const item = parsed.data as { kind?: string; revision?: number };
  return item.kind === row.kind && item.revision === row.revision ? parsed.data : "invalid";
}

const accountRow = (id: string): SourceAccountRow => ({
  id: SourceAccountId.parse(id),
  label: "",
  connector: "lens_contacts",
  sourceKind: "crm",
  compartment: "own",
});

// The decided state, or taken when nothing is owed.
async function mark(
  tx: Tx,
  id: string,
  decided: { evidenceId?: string; code?: MacContactDrop },
  owed: boolean,
): Promise<void> {
  await tx.query(
    `update ledger.capture_inbox set evidence_id = coalesce($2, evidence_id), refused_code = coalesce($3, refused_code),
       taken_at = case when $4::boolean then null else now() end, body_enc = case when $4::boolean then body_enc else null end
     where id = $1`,
    [id, decided.evidenceId ?? null, decided.code ?? null, owed],
  );
}

// An earlier revision of this item removed through the deletion path; its phones' fingerprints.
// `dropped` where the contact is still on the Mac and is left out or held by another source's
// item; `deleted` where the Mac's listing no longer holds it.
async function removeItem(
  tx: Tx,
  accountId: string,
  itemFp: string,
  reason: RemovalReason,
): Promise<{ removed: boolean; phones: string[] }> {
  const phones = (await tx.query<{ phone_fps: string[] }>(PHONES_OF, [accountId, itemFp])).flatMap(
    (row) => row.phone_fps,
  );
  const gone = await removeSourceItem(tx, { id: accountId, compartment: "own" }, itemFp, reason);
  return { removed: gone.removed, phones };
}

type Decision =
  | { kind: "done"; phones: string[] }
  | { kind: "ingest"; item: MacContactItem; raw: RawItem; accountId: string; itemFp: string; phones: string[] }
  | "waiting"
  | "skipped";

// Step 1 for one fresh row, in its own transaction: every check before the ingest. A drop that
// removes an earlier revision owes the re-ask of its phones.
async function decide(ctx: ContactsContext, tx: Tx, id: string, counts: ContactsTaken): Promise<Decision> {
  const [row] = await tx.query<Row>(`${ROW} where id = $1 for update`, [id]);
  if (
    row === undefined ||
    row.body_enc === null ||
    row.evidence_id !== null ||
    row.refused_code !== null ||
    row.kind !== "contact"
  )
    return "skipped";
  const drop = async (code: MacContactDrop, phones: string[] = []): Promise<Decision> => {
    add(counts, code);
    await mark(tx, id, { code }, phones.length > 0);
    return { kind: "done", phones };
  };
  const item = bodyOf(tx, row, MacContactItem);
  if (item === null) return "waiting";
  if (item === "invalid") return drop("invalid_item");
  const [device] = await tx.query<{ name: string; on: boolean; account_id: string | null }>(DEVICE, [row.client_id]);
  if (device === undefined || !device.on) return drop("switched_off");
  if (device.account_id === null) throw new Error("contacts: no lens_contacts account for the device");
  const accountId = device.account_id;
  if ([item.name, item.nickname, ...item.emails].some((text) => text !== undefined && systemIdIn(text)))
    return drop("system_ids");
  const raw = macContactItem(item, {
    sourceAccount: SourceAccountId.parse(accountId),
    now: ctx.now().toISOString() as Timestamp,
  });
  const itemFp = fingerprint(tx.keys, "source_id", raw.sourceItemId);
  const kept = contactKept(raw, await ownerAddresses(tx));
  if (kept !== "keep") return drop(kept, (await removeItem(tx, accountId, itemFp, "dropped")).phones);
  const [phone] = item.phones;
  if (!emailed(raw) && phone !== undefined) {
    const [answer] = await tx.query<{ outranked: boolean }>(OUTRANKED, [
      phoneFp(tx.keys, phone),
      telFp(tx.keys, phone),
      accountId,
      itemFp,
      fingerprint(tx.keys, "name", phone),
    ]);
    if (answer?.outranked === true)
      return drop("outranked", (await removeItem(tx, accountId, itemFp, "dropped")).phones);
  }
  const phones = (await tx.query<{ phone_fps: string[] }>(PHONES_OF, [accountId, itemFp])).flatMap(
    (one) => one.phone_fps,
  );
  return { kind: "ingest", item, raw, accountId, itemFp, phones };
}

// Step 1, after the ingest, in a second transaction: the row decided, and each stored phone-only
// Mac contact a Mac contact with an email now holds the phone of, removed.
async function settle(
  tx: Tx,
  id: string,
  decision: Extract<Decision, { kind: "ingest" }>,
  answer: IngestAnswer,
  received: Date,
  counts: ContactsTaken,
): Promise<string[]> {
  const { item, raw, accountId, itemFp } = decision;
  const own = item.phones.map((one) => phoneFp(tx.keys, one));
  const [latest] = await tx.query<{ id: string; observed_at: Date }>(LATEST, [accountId, itemFp]);
  let phones: string[] = [];
  if (answer === "suppressed" || answer === "removed" || latest === undefined) {
    add(counts, "suppressed");
    phones = decision.phones;
    await mark(tx, id, { code: "suppressed" }, phones.length > 0);
    return phones;
  }
  // A row whose own revision a run killed before its mark stored: its re-ask and its removals are
  // still owed.
  const retaken = answer === "repeat" && latest.observed_at.getTime() >= received.getTime();
  if (answer === "repeat") {
    counts.unchanged += 1;
    if (retaken) phones = own;
  } else {
    counts.stored += 1;
    phones = [...decision.phones, ...own];
  }
  if ((answer !== "repeat" || retaken) && emailed(raw)) {
    const keys = item.phones.map((one) => telFp(tx.keys, one)).filter((one): one is string => one !== null);
    for (const other of await tx.query<{ account_id: string; source_contact_fp: string }>(PHONE_ONLY, [
      keys,
      accountId,
      itemFp,
    ])) {
      const gone = await removeItem(tx, other.account_id, other.source_contact_fp, "dropped");
      if (gone.removed) counts.removed += 1;
      phones.push(...gone.phones);
    }
  }
  const unique = [...new Set(phones)];
  await mark(tx, id, { evidenceId: latest.id }, unique.length > 0);
  return unique;
}

// The phones of an owed row, from its body.
function owedPhones(tx: Tx, row: Row): string[] {
  const item = bodyOf(tx, row, MacContactItem);
  return item === null || item === "invalid" ? [] : item.phones.map((one) => phoneFp(tx.keys, one));
}

// Step 2 for one listing, inside step 3's transaction: every Mac contact of the device not in its
// keys whose latest inbox row arrived before it, or has none left, removed through the deletion
// path. Null when it must wait: a contact row of its device that arrived before it is not yet
// decided.
async function applyListing(tx: Tx, row: Row, counts: ContactsTaken): Promise<string[] | null> {
  const [before] = await tx.query<{ waiting: boolean }>(
    `select exists (select 1 from ledger.capture_inbox where client_id = $1 and kind = 'contact' and taken_at is null and evidence_id is null and refused_code is null
       and (received_at, id) < ($2::timestamptz, $3::text)) as waiting`,
    [row.client_id, row.received_at, row.id],
  );
  if (before?.waiting === true) return null;
  const listing = bodyOf(tx, row, MacContactsListed);
  if (listing === null) return null;
  if (listing === "invalid") {
    add(counts, "invalid_item");
    await mark(tx, row.id, { code: "invalid_item" }, false);
    return [];
  }
  const [device] = await tx.query<{ on: boolean; account_id: string | null }>(DEVICE, [row.client_id]);
  if (device === undefined || !device.on || device.account_id === null) {
    add(counts, "switched_off");
    await mark(tx, row.id, { code: "switched_off" }, false);
    return [];
  }
  const kept = new Set(listing.keys.map((key) => fingerprint(tx.keys, "source_id", macContactItemId(key))));
  const stored = await tx.query<{ source_item_fp: string; id: string; item_enc: Sealed; compartments: string[] }>(
    `select distinct on (source_item_fp) source_item_fp, id, item_enc, compartments from vault.evidence_items
     where source_account_id = $1 order by source_item_fp, revision desc`,
    [device.account_id],
  );
  const phones: string[] = [];
  for (const one of stored) {
    if (kept.has(one.source_item_fp)) continue;
    const sourceItemId = (
      JSON.parse(open(tx.keys, one, "vault.evidence_items.item_enc", "throw")) as { sourceItemId?: unknown }
    ).sourceItemId;
    if (typeof sourceItemId !== "string" || !sourceItemId.startsWith("contact:lens:")) continue;
    const key = `contact:${sourceItemId.slice("contact:lens:".length)}`;
    const [latest] = await tx.query<{ at: Date | null }>(
      "select max(received_at) as at from ledger.capture_inbox where client_id = $1 and kind = 'contact' and source_key_fp = $2",
      [row.client_id, fingerprint(tx.keys, "source_id", key)],
    );
    if (latest?.at !== null && latest?.at !== undefined && latest.at.getTime() >= row.received_at.getTime()) continue;
    const gone = await removeItem(tx, device.account_id, one.source_item_fp, "deleted");
    if (gone.removed) counts.removed += 1;
    phones.push(...gone.phones);
  }
  await mark(tx, row.id, {}, false);
  return phones;
}

// The caller holds the extraction lock. Exported for the switch's `off` (lens-admin.ts).
export async function reaskMoments(tx: Tx, noted: ReadonlySet<string>): Promise<number> {
  if (noted.size === 0) return 0;
  let due = 0;
  for (const moment of await tx.query<{ id: string; evidence_id: string; compartments: string[]; facts_enc: Sealed }>(
    SOURCE_MOMENTS,
  )) {
    let facts: MomentCaptureFacts;
    try {
      facts = JSON.parse(open(tx.keys, moment, "knowledge.captures.facts_enc", "throw")) as MomentCaptureFacts;
    } catch {
      continue;
    }
    if (!momentPhonesOf(facts).some((phone) => noted.has(phoneFp(tx.keys, phone)))) continue;
    due += (
      await tx.query(
        "update vault.pipeline_items set extractor_generation = 0 where evidence_id = $1 and extractor_generation <> 0 returning evidence_id",
        [moment.evidence_id],
      )
    ).length;
  }
  return due;
}

// Step 3, under the extraction lock: the listings, then the re-ask, then the owed
// rows taken. False when the lock is held elsewhere: nothing is written.
async function reask(
  tx: Tx,
  noted: Set<string>,
  owed: string[],
  listings: Row[],
  counts: ContactsTaken,
): Promise<boolean> {
  if ((await tx.query<{ held: boolean }>(TRY_EXTRACT))[0]?.held !== true) return false;
  for (const listing of listings) {
    const phones = await applyListing(tx, listing, counts);
    if (phones === null) counts.waiting += 1;
    else for (const one of phones) noted.add(one);
  }
  counts.momentsDue += await reaskMoments(tx, noted);
  if (owed.length > 0)
    await tx.query(
      "update ledger.capture_inbox set taken_at = now(), body_enc = null where id = any($1) and taken_at is null",
      [owed],
    );
  return true;
}

// `pi sync`'s step: at most `limit` fresh contact rows, those with an email first, then oldest
// first, each decided in a transaction of its own and ingested by the writer in its own; then the
// listings and the re-ask in one. A row that fails is counted and left for the next run; a lost
// connection or lock ends the run.
export function takeContacts(ctx: ContactsContext, limit = 500): Promise<ContactsTaken> {
  return ctx.write(async () => {
    const counts: ContactsTaken = {
      stored: 0,
      unchanged: 0,
      removed: 0,
      momentsDue: 0,
      dropped: {},
      failed: 0,
      waiting: 0,
    };
    const rethrow = (error: unknown): void => {
      if (isCoded(error, "unavailable")) throw error;
    };
    const fresh = await ctx.direct.query<Row>(FRESH, ["contact", limit * 2]);
    // Those with an email first: read from each body, opened once.
    const emails = new Map(
      fresh.map((row) => [
        row.id,
        (() => {
          const item = bodyOf(ctx.direct, row, MacContactItem);
          return item !== null && item !== "invalid" && item.emails.length > 0;
        })(),
      ]),
    );
    const ordered = [
      ...fresh.filter((row) => emails.get(row.id) === true),
      ...fresh.filter((row) => emails.get(row.id) !== true),
    ].slice(0, limit);
    const noted = new Set<string>();
    const owed = new Set<string>();
    for (const row of await ctx.direct.query<Row>(OWED, ["contact", limit])) {
      owed.add(row.id);
      for (const one of owedPhones(ctx.direct, row)) noted.add(one);
    }
    for (const row of ordered) {
      try {
        const decision = await ctx.write(() => ctx.transaction((tx) => decide(ctx, tx, row.id, counts)));
        if (decision === "skipped") continue;
        if (decision === "waiting") {
          counts.waiting += 1;
          continue;
        }
        let phones = decision.kind === "done" ? decision.phones : [];
        if (decision.kind === "ingest") {
          const answer = await ctx.write(() =>
            ctx.ingest(accountRow(decision.accountId), decision.raw, (itemCtx) =>
              deriveItem(decision.raw, itemCtx, PERSONAL_LIMITS),
            ),
          );
          phones = await ctx.write(() =>
            ctx.transaction((tx) => settle(tx, row.id, decision, answer, row.received_at, counts)),
          );
        }
        if (phones.length > 0) {
          owed.add(row.id);
          for (const one of phones) noted.add(one);
        }
      } catch (error) {
        rethrow(error);
        counts.failed += 1;
      }
    }
    const listings = await ctx.direct.query<Row>(FRESH, ["contacts", limit]);
    if (noted.size > 0 || owed.size > 0 || listings.length > 0) {
      try {
        const done = await ctx.write(() => ctx.transaction((tx) => reask(tx, noted, [...owed], listings, counts)));
        if (!done) counts.waiting += owed.size + listings.length;
      } catch (error) {
        rethrow(error);
        counts.failed += 1;
      }
    }
    return counts;
  });
}
