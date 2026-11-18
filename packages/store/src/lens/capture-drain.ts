import {
  type BlockCut,
  type BlockItem,
  type BlockPage,
  CaptureItem,
  isCoded,
  isSignInUrl,
  type MeetingItem,
  RESTRICTED_PREFIX,
  type RestrictedCategory,
  TASK_FUTURE_MS,
} from "@intelligence/contracts/personal";
import { normalizeAddress } from "@intelligence/personal-core";
import { credentialShaped, meetingText, pathText, systemIdIn } from "@intelligence/personal-core/lens";
import { fpsMemo, suppressedFps, withoutNamed } from "../core/capture-pages.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { CAPTURE_KINDS_SQL, CAPTURE_LANES, isCaptureKind } from "../core/lanes.ts";
import type { Sealed } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";
import { removeSourceItem } from "../write/writer-item-removal.ts";
import {
  admitted,
  agentOf,
  BLOCK_DROPS,
  badEvents,
  blockSystemTexts,
  cutReason,
  exclusionOf,
  hostOf,
  type Item,
  pathOf,
  type Rule,
  recovery,
  ruleOf,
  type Scope,
  screened,
  systemTexts,
  unfiledCut,
} from "./capture-admit.ts";
import { defaultAdmits, isMultiAccount, isSourceBundle } from "./capture-push.ts";
import { linkOf, type Part, writePart } from "./capture-write.ts";
import { readInbox } from "./inbox-body.ts";

// Lens's drain: the inbox's capture items taken one row at a time, each checked, labelled and
// written, or dropped, waiting or failed, and the counts `pi sync` answers.

// What `pi sync`'s drain answers: items taken, replacing an earlier revision, dropped by code, failed,
// and waiting for a key or a calendar. `attributeRefused`: the block attributes the drain's check left
// out of work_enc, by method. `byDefault`: the blocks the default admitted, present when there were any.
export type CaptureCounts = {
  taken: number;
  replaced: number;
  dropped: Record<string, number>;
  failed: number;
  waiting: number;
  attributeRefused?: Record<string, number>;
  byDefault?: number;
  // The meetings taken with no scope rule naming them (labelled by the account map or
  // `own`), and the meetings taken with no account; each present when there were any.
  meetingsByDefault?: number;
  meetingsNoAccount?: number;
  // Block day revisions that grew, those that did not, and the records those tainted.
  blockRevisions?: { grown: number; changed: number; tainted: number };
};

// What the drain is given: the box's own host, from `pi sync`'s PI_HTTP_BASE_URL;
// with none, it admits nothing by default.
export type DrainOptions = { boxHost?: string | undefined };

// The writer's means, as its record intake uses them.
export type DrainContext = {
  direct: Tx;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  write<T>(call: () => Promise<T>): Promise<T>;
};

// The kinds a capture row is made of: a forget is settleForgets', and a Mac contact and a listing
// takeContacts'.
const isCaptured = (item: CaptureItem): item is Item => isCaptureKind(item.kind);

// Adds `count` to a code's tally.
const tally = (into: Record<string, number>, code: string, count = 1): void => {
  into[code] = (into[code] ?? 0) + count;
};

// `dropped`: a block day's blocks and cut entries dropped alone, by code:
// `out_of_scope`, `excluded`, `system_ids`, `recovery` and `cut_dropped`; `byDefault`, its blocks
// the default admitted. `counts`, a day all of whose blocks are dropped: each code's count,
// the row taking the commonest.
type Outcome =
  | {
      taken: "taken" | "replaced";
      dropped?: Record<string, number>;
      byDefault?: number;
      meeting?: { byDefault: boolean; noAccount: boolean };
      blockRevisions?: { grown: number; changed: number; tainted: number };
      pageDropped?: Record<string, number>;
      refused?: Record<string, number>;
    }
  | { dropped: string; counts?: Record<string, number> }
  | "waiting"
  | "skipped";

// The rows the drain may select, oldest first, a page at a time after the last row the run read
// ($2, $3: its time as text, which keeps the microseconds, and its id); forgets are settleForgets'.
// Tasks after the other kinds. A Mac contact or a listing is takeContacts' (capture-contacts.ts),
// never a capture.
const SELECTABLE = `
  select id, received_at::text as at from ledger.capture_inbox
  where kind in (${CAPTURE_KINDS_SQL}) and body_enc is not null and evidence_id is null and refused_code is null
    and (kind = 'task') = $4::boolean
    and ($2::timestamptz is null or (received_at, id) > ($2::timestamptz, $3::text))
  order by received_at, id limit $1`;

// Whether this revision was pushed inside the pushing device's one vouched backfill
// window.
const VOUCHED = `
  select exists (select 1 from policy.lens_devices d where d.capture_client_id = $1
                 and $2::timestamptz between d.backfill_vouch_from and d.backfill_vouch_to) as vouched`;

// Whether the pushing device's task switch is on, again at drain.
const TASKS_ON =
  "select coalesce((select d.tasks from policy.lens_devices d where d.capture_client_id = $1), false) as on";
// An inbox row is kept 30 days after it is taken, then deleted by the drain.
const PRUNE = "delete from ledger.capture_inbox where taken_at < now() - interval '30 days'";

// A meeting waits until a calendar sync of every connected label has completed after
// its end, and at most 24 hours. A label is connected while its client secret is stored.
const CALENDAR_PENDING = `
  select (now() < $1::timestamptz + interval '24 hours') and exists (
    select 1 from vault.source_accounts a
    where a.connector = 'google_calendar'
      and exists (select 1 from policy.secrets s where s.name = 'google/' || a.label || '/client')
      and not coalesce(a.last_outcome = 'ok' and a.last_sync_at >= $1::timestamptz, false)) as pending`;

// Whether retention expired any revision of these source items. For a block day, once any split expired
// the whole day is never stored again: a day is past its window by its own date.
const EXPIRED =
  "select exists (select 1 from vault.evidence_items where source_account_id = $1 and source_item_fp = any($2::text[]) and expired_at is not null) as expired";

// A series' first part still in the inbox, not yet taken, waiting or failed.
const FIRST_PART_PENDING = `
  select exists (
    select 1 from ledger.capture_inbox
    where client_id = $1 and source_key_fp = $2 and kind = 'meeting' and body_enc is not null and evidence_id is null and refused_code is null) as pending`;

// A mail moment whose account is the address of a connected Google label.
const CONNECTED_MAIL = `
  select exists (
    select 1 from vault.source_accounts a
    where a.connector = 'google_mail' and a.address_fp = $1
      and exists (select 1 from policy.secrets s where s.name = 'google/' || a.label || '/client')) as connected`;

// A key a forget or an owner erasure removed.
const REMOVED = `
  select exists (select 1 from knowledge.removed_evidence
                 where source_account_id = $1 and source_item_fp = any($2::text[]) and reason in ('device_forget', 'owner_erasure')) as removed`;

type InboxRow = {
  id: string;
  client_id: string;
  kind: string;
  revision: number;
  source_key_fp: string;
  content_fp: string;
  body_enc: Sealed | null;
  evidence_id: string | null;
  refused_code: string | null;
  received_at: Date;
};
type Stored = { id: string; evidence_id: string; revision: number; first_pushed_at: Date; source_item_fp: string };

type Done = { done: Outcome };
type Drop = (code: string) => Promise<Outcome>;
// A part's checks before it is stored: the parts, the blocks dropped alone, and the blocks the
// default admitted.
type Parted = {
  parts: Part[];
  blockDropped: Record<string, number>;
  byDefault: number;
  deny: boolean;
  excluded: ReturnType<typeof exclusionOf>;
  unfiled?: BlockCut[];
  meeting?: { byDefault: boolean; noAccount: boolean };
};

// One selected row, in the caller's transaction: its item opened and checked, its parts admitted and checked,
// then stored.
async function takeOne(tx: Tx, id: string, on: readonly RestrictedCategory[], scope: Scope): Promise<Outcome> {
  const [row] = await tx.query<InboxRow>(
    "select id, client_id, kind, revision, source_key_fp, content_fp, body_enc, evidence_id, refused_code, received_at from ledger.capture_inbox where id = $1 for update",
    [id],
  );
  if (
    row === undefined ||
    row.body_enc === null ||
    row.evidence_id !== null ||
    row.refused_code !== null ||
    !isCaptureKind(row.kind)
  )
    return "skipped";
  const drop: Drop = async (code) => {
    await tx.query(
      "update ledger.capture_inbox set refused_code = $2, taken_at = now(), body_enc = null where id = $1",
      [id, code],
    );
    return { dropped: code };
  };

  const opened = await openedItem(tx, row, drop);
  if ("done" in opened) return opened.done;

  const [account] = await tx.query<{ id: string }>(
    `select a.id from policy.lens_devices d join vault.source_accounts a on a.label = 'device:' || d.name and a.connector = $2
     where d.capture_client_id = $1`,
    [row.client_id, CAPTURE_LANES[opened.kind].connector],
  );
  if (account === undefined) throw new Error("capture: no source account for the device");
  const accountId = account.id;

  if (await meetingWaits(tx, opened, row)) return "waiting";
  const parted = await partsOf(tx, opened, row, scope, drop);
  if ("done" in parted) return parted.done;
  const checked = await checkedParts(tx, opened, parted.parts, accountId, drop);
  if ("done" in checked) return checked.done;
  return storeParts(tx, id, row, on, scope, accountId, checked.item, checked.parts, checked.fps, parted, drop);
}

// 1. The body, under `own`, against its content fingerprint, and its item; a task's own checks. One
// that will not open waits.
async function openedItem(tx: Tx, row: InboxRow, drop: Drop): Promise<Item | Done> {
  let read: ReturnType<typeof readInbox>;
  try {
    read = readInbox(tx.keys, row);
  } catch {
    return { done: "waiting" };
  }
  if (typeof read === "string") return { done: await drop(read) };
  const { raw } = read;
  // A task's events out of order, or not starting with created, are its own code.
  if (row.kind === "task" && badEvents(raw)) return { done: await drop("bad_events") };
  const parsed = CaptureItem.safeParse(raw);
  if (
    !parsed.success ||
    !isCaptured(parsed.data) ||
    parsed.data.kind !== row.kind ||
    parsed.data.revision !== row.revision
  )
    return { done: await drop("invalid_item") };
  const item: Item = parsed.data;
  // A task is the owner's word only with Lens's owner-channel mark, only
  // while the device's switch is on, and only with no time more than five minutes after its push.
  if (item.kind === "task") {
    if (item.byOwner !== true) return { done: await drop("not_owner") };
    if ((await tx.query<{ on: boolean }>(TASKS_ON, [row.client_id]))[0]?.on !== true)
      return { done: await drop("out_of_scope") };
    const latest = row.received_at.getTime() + TASK_FUTURE_MS;
    if (
      [...item.events.map((event) => event.at), ...(item.doneAt === undefined ? [] : [item.doneAt])].some(
        (at) => Date.parse(at) > latest,
      )
    )
      return { done: await drop("future_time") };
  }
  return item;
}

// A meeting waits for the calendars. A later part waits for its series' first
// part, so it links to that part's event.
async function meetingWaits(tx: Tx, item: Item, row: InboxRow): Promise<boolean> {
  if (item.kind !== "meeting") return false;
  const [pending] = await tx.query<{ pending: boolean }>(CALENDAR_PENDING, [item.endedAt]);
  if (pending?.pending === true) return true;
  if (item.series !== undefined && item.series !== item.key) {
    const [first] = await tx.query<{ pending: boolean }>(FIRST_PART_PENDING, [
      row.client_id,
      fingerprint(tx.keys, "source_id", item.series),
    ]);
    if (first?.pending === true) return true;
  }
  return false;
}

// 2. The scope again: the item's parts, each under the compartment its rule gives; the device's mode
// now, and the exclude list first.
async function partsOf(tx: Tx, item: Item, row: InboxRow, scope: Scope, drop: Drop): Promise<Parted | Done> {
  const { rules } = scope;
  const deny = scope.deny.has(row.client_id);
  const excluded = exclusionOf(tx, scope.excludes);
  let parts: Part[];
  const blockDropped: Record<string, number> = {};
  const dropBlock = (code: string): void => tally(blockDropped, code);
  let byDefault = 0;
  let meeting: Parted["meeting"];
  const unfiled: BlockCut[] = [];
  if (item.kind === "block") {
    // Each block alone, in order: its host excluded; no rule or default admitting it; a system id
    // or a recovery marker in its own fields.
    const groups = new Map<string, BlockItem["blocks"]>();
    for (const block of item.blocks) {
      const admit = admitted(tx, scope, deny, excluded, block.app.bundle, block.host, block.account);
      if ("code" in admit) dropBlock(admit.code);
      else if (blockSystemTexts(block).some(systemIdIn)) dropBlock("system_ids");
      else if (recovery([block.title, block.document?.value, block.folder?.value])) dropBlock("recovery");
      else {
        if (admit.byDefault) byDefault += 1;
        groups.set(admit.compartment, [...(groups.get(admit.compartment) ?? []), block]);
      }
    }
    if (groups.size === 0) {
      // A day of dropped blocks alone takes the code that dropped the most, the first in
      // BLOCK_DROPS on a tie, and keeps each code's count.
      const code = BLOCK_DROPS.reduce(
        (best, one) => ((blockDropped[one] ?? 0) > (blockDropped[best] ?? 0) ? one : best),
        BLOCK_DROPS[0],
      );
      await drop(code);
      return { done: { dropped: code, counts: blockDropped } };
    }
    // Each cut entry takes the compartment its scope rule gives, as a block's
    // does; one no rule admits is dropped. Each split keeps its own entries, in its blob and its
    // work_enc. An entry whose compartment holds no block of the day has no split to go in; it is
    // counted. An entry of an excluded host is dropped `excluded`, and the default admits one as it
    // admits a block. An entry no rule could ever admit, for want of an account, a host or an app, has no
    // compartment at all: it is unfiled, sealed on one split once labels are known.
    const cuts = new Map<string, BlockCut[]>();
    for (const cut of item.cut ?? []) {
      const admit = admitted(tx, scope, deny, excluded, cut.app, cut.host, cut.account);
      if ("code" in admit && admit.code === "excluded") dropBlock("excluded");
      else if ("compartment" in admit && groups.has(admit.compartment))
        cuts.set(admit.compartment, [...(cuts.get(admit.compartment) ?? []), cut]);
      else if ("code" in admit && cutReason(cut) !== "other") unfiled.push(cut);
      else dropBlock("cut_dropped");
    }
    const { cut: _cut, ...day } = item;
    parts = [...groups.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([compartment, blocks]) => {
        const own = cuts.get(compartment) ?? [];
        return {
          item: { ...day, blocks, ...(own.length === 0 ? {} : { cut: own }) },
          sourceItemId: `${day.key}#${compartment}`,
          compartment,
        };
      });
  } else if (item.kind === "task") {
    // A task's label is `own`: the Tasks tab is Lens's own surface.
    parts = [{ item, sourceItemId: item.key, compartment: "own" }];
  } else if (item.kind === "meeting") {
    // A meeting is admitted whatever the rules, the exclude list included. A rule naming its surface and account gives its compartment; else the account
    // map's for its account; else `own`. Its bundle, host and account are kept as they came. An
    // agent-app rule admits no meeting (the migration's check).
    const rule = ruleOf(tx, rules, "meeting", item.app.bundle, item.host, item.account);
    const mapped =
      rule !== null || item.account === undefined
        ? undefined
        : scope.accounts.get(fingerprint(tx.keys, "capture_scope", item.account));
    parts = [{ item, sourceItemId: item.key, compartment: rule?.compartment ?? mapped ?? "own" }];
    meeting = { byDefault: rule === null, noAccount: item.account === undefined };
  } else {
    // A moment on an excluded host is dropped whole, whatever rule admits it.
    if (excluded(hostOf(item))) return { done: await drop("excluded") };
    // A moment of a source's app read from the screen is out of scope whatever the rules; this catches one pushed before the push refused it.
    if (item.kind === "moment" && item.source === undefined && isSourceBundle(item.app.bundle))
      return { done: await drop("out_of_scope") };
    const rule = ruleOf(tx, rules, "moment", item.app.bundle, hostOf(item), item.account, item.source ?? null);
    if (rule === null) return { done: await drop("out_of_scope") };
    // A moment an agent-app rule admits is agent output.
    const agent = await agentOf(tx, rule);
    parts = [
      { item, sourceItemId: item.key, compartment: rule.compartment, ...(agent === undefined ? {} : { agent }) },
    ];
  }
  return {
    parts,
    blockDropped,
    byDefault,
    deny,
    excluded,
    ...(unfiled.length > 0 ? { unfiled } : {}),
    ...(meeting === undefined ? {} : { meeting }),
  };
}

// The system id and recovery checks, the connected label, a removed key and retention's expiry: the
// item and its parts as they are stored, a meeting's matching segments blanked, and the parts' source
// fingerprints.
async function checkedParts(
  tx: Tx,
  opened: Item,
  checking: Part[],
  accountId: string,
  drop: Drop,
): Promise<{ item: Item; parts: Part[]; fps: string[] } | Done> {
  let item = opened;
  let parts = checking;
  // A block day's blocks were checked one by one above.
  if (item.kind !== "block" && systemTexts(item).some(systemIdIn)) return { done: await drop("system_ids") };
  if (item.kind === "moment" && recovery([item.window, item.text, item.document, ...pathOf(item.url)]))
    return { done: await drop("recovery") };
  if (item.kind === "task" && recovery([item.title, item.project])) return { done: await drop("recovery") };
  if (item.kind === "meeting") {
    if (recovery([item.title, item.calendar?.title])) return { done: await drop("recovery") };
    // A meeting keeps its hour; each segment that matches is blanked, and counted in
    // its facts. Its notes that match are blanked the same way.
    const meeting: MeetingItem = item;
    item = {
      ...meeting,
      segments: meeting.segments.map((segment) => (recovery([segment.text]) ? { ...segment, text: "" } : segment)),
      ...(meeting.notes !== undefined && recovery([meeting.notes]) ? { notes: "" } : {}),
    };
    parts = parts.map((part) => ({ ...part, item }));
  }
  if (item.kind === "moment" && item.entity === "mail" && item.account !== undefined) {
    const address = normalizeAddress(item.account);
    if (
      address !== null &&
      (await tx.query<{ connected: boolean }>(CONNECTED_MAIL, [fingerprint(tx.keys, "address", address)]))[0]
        ?.connected === true
    )
      return { done: await drop("connected_source") };
  }
  const fps = parts.map((part) => fingerprint(tx.keys, "source_id", part.sourceItemId));
  const plain = fingerprint(tx.keys, "source_id", item.key);
  if ((await tx.query<{ removed: boolean }>(REMOVED, [accountId, [...new Set([plain, ...fps])]]))[0]?.removed === true)
    return { done: await drop("removed") };
  // An item retention expired is never stored again, whatever revision Lens sends of it. A block day's expiry is by split, and a new revision may split it under another compartment,
  // so every split the key file's compartments can name is asked, and the plain key.
  const splits =
    item.kind === "block"
      ? [...tx.keys.compartments.keys()].map((compartment) =>
          fingerprint(tx.keys, "source_id", `${item.key}#${compartment}`),
        )
      : [];
  if (
    (await tx.query<{ expired: boolean }>(EXPIRED, [accountId, [...new Set([plain, ...fps, ...splits])]]))[0]
      ?.expired === true
  )
    return { done: await drop("expired") };
  return { item, parts, fps };
}

// 3 and 4. What is stored of the key, locked; a replay or an older revision; the link and each
// part's label; then each part written and the row marked taken.
async function storeParts(
  tx: Tx,
  id: string,
  row: InboxRow,
  on: readonly RestrictedCategory[],
  scope: Scope,
  accountId: string,
  item: Item,
  parts: Part[],
  fps: string[],
  { blockDropped, byDefault, deny, excluded, unfiled, meeting }: Parted,
  drop: Drop,
): Promise<Outcome> {
  // What is stored of the key: every split of a block day. Locked, their evidence rows after them.
  const stored = await tx.query<Stored>(
    `select c.id, c.evidence_id, c.revision, c.first_pushed_at, e.source_item_fp from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id
     where c.source_account_id = $1 and c.capture_key = $2 order by c.id for update of c`,
    [accountId, item.key],
  );
  const revisions = await tx.query<{ id: string; source_item_fp: string; revision: number }>(
    "select id, source_item_fp, revision from vault.evidence_items where source_account_id = $1 and source_item_fp = any($2::text[]) order by id for update",
    [accountId, [...new Set([...fps, ...stored.map((one) => one.source_item_fp)])]],
  );
  // This revision is stored already, its inbox row having been pruned: replayed.
  const same = revisions.find((one) => one.revision === item.revision && fps.includes(one.source_item_fp));
  if (same !== undefined) {
    await tx.query(
      "update ledger.capture_inbox set evidence_id = $2, taken_at = now(), body_enc = null where id = $1",
      [id, same.id],
    );
    return { taken: "taken" };
  }
  if (revisions.some((one) => one.revision > item.revision)) return drop("out_of_order");

  // 4. The link, for a meeting, before the label (3), which includes the linked event's compartments.
  const linked = item.kind === "meeting" ? await linkOf(tx, item, accountId) : null;

  // 3. Each part's label: the rule's compartment, the linked event's, and the screen's.
  const labelled = parts.map((part) => {
    const texts =
      part.item.kind === "meeting"
        ? [part.item.title, part.item.calendar?.title, meetingText(part.item).text]
        : part.item.kind === "moment"
          ? [part.item.window, part.item.text]
          : part.item.kind === "task"
            ? [part.item.title, part.item.project]
            : part.item.blocks.map((block) => block.title);
    const label = [
      ...new Set([
        part.compartment,
        ...(part.agent?.compartments ?? []),
        ...(linked?.compartments ?? []),
        ...screened(texts, on),
      ]),
    ].sort();
    return { ...part, label };
  });
  // A key the label needs and the key file lacks: the row waits.
  if (labelled.some((part) => part.label.some((one) => !tx.keys.compartments.has(one)))) return "waiting";
  // On a split no restricted term labelled, which a caller cleared for all the
  // compartments can read.
  if (unfiled !== undefined) {
    const carrier =
      labelled.find((part) => !part.label.some((one) => one.startsWith(RESTRICTED_PREFIX))) ?? labelled[0];
    if (carrier !== undefined) carrier.unfiled = unfiledCut(unfiled, [...tx.keys.compartments.keys()]);
  }
  // Each history page of a split by its own scope rule and checks.
  const pageDropped: Record<string, number> = {};
  if (item.kind === "block")
    await keepPages(
      tx,
      scope,
      deny,
      excluded,
      on,
      labelled as (Part & { item: BlockItem; label: string[] })[],
      pageDropped,
    );

  // The earliest push of the key, never moved by a later revision.
  const [pushed] = await tx.query<{ at: Date | null }>(
    "select min(received_at) as at from ledger.capture_inbox where client_id = $1 and source_key_fp = $2",
    [row.client_id, row.source_key_fp],
  );
  const firstPushedAt =
    stored.reduce<Date | null>(
      (earliest, one) => (earliest === null || one.first_pushed_at < earliest ? one.first_pushed_at : earliest),
      null,
    ) ??
    pushed?.at ??
    new Date();

  // A split the new revision no longer holds goes as a source deletion does.
  const kept = new Set(fps);
  for (const fp of new Set(stored.map((one) => one.source_item_fp))) {
    if (!kept.has(fp)) await removeSourceItem(tx, { id: accountId, compartment: "own" }, fp, "replaced");
  }

  let first: string | null = null;
  const refused: Record<string, number> = {};
  const vouched =
    item.kind === "moment" &&
    item.source !== undefined &&
    (await tx.query<{ vouched: boolean }>(VOUCHED, [row.client_id, row.received_at]))[0]?.vouched === true;
  const blockRevisions = { grown: 0, changed: 0, tainted: 0 };
  for (const part of labelled) {
    const written = await writePart(
      tx,
      part,
      accountId,
      linked,
      { first: firstPushedAt, revision: row.received_at, vouched },
      revisions.filter((one) => one.source_item_fp === fingerprint(tx.keys, "source_id", part.sourceItemId)),
    );
    for (const [method, count] of Object.entries(written.refused)) tally(refused, method, count ?? 0);
    first ??= written.evidenceId;
    if (written.blockRevision !== undefined) {
      if (written.blockRevision.grown) blockRevisions.grown += 1;
      else blockRevisions.changed += 1;
      blockRevisions.tainted += written.blockRevision.tainted;
    }
  }
  await tx.query("update ledger.capture_inbox set evidence_id = $2, taken_at = now(), body_enc = null where id = $1", [
    id,
    first,
  ]);
  return {
    taken: stored.length > 0 ? "replaced" : "taken",
    ...(Object.keys(blockDropped).length > 0 ? { dropped: blockDropped } : {}),
    ...(byDefault > 0 ? { byDefault } : {}),
    ...(meeting === undefined ? {} : { meeting }),
    ...(Object.keys(pageDropped).length > 0 ? { pageDropped } : {}),
    ...(Object.keys(refused).length > 0 ? { refused } : {}),
    ...(blockRevisions.grown + blockRevisions.changed > 0 ? { blockRevisions } : {}),
  };
}

// Each split's blocks with only the history pages that pass, each dropped page counted by its code. A
// page is admitted by its own host's rule for kind `block`, with the block's bundle and no account, and
// kept only under the split's compartment and by no agent-app rule; then its own text checks; then the
// erasures' suppressed names and addresses, in one read for the item, each run fingerprinted once.
async function keepPages(
  tx: Tx,
  scope: Scope,
  deny: boolean,
  excluded: (host: string | undefined) => boolean,
  on: readonly RestrictedCategory[],
  parts: (Part & { item: BlockItem; label: string[] })[],
  dropped: Record<string, number>,
): Promise<void> {
  const drop = (code: string): false => {
    tally(dropped, code);
    return false;
  };
  const passes = (part: Part & { label: string[] }, block: BlockItem["blocks"][number], page: BlockPage): boolean => {
    const host = URL.parse(page.url)?.hostname.toLowerCase().replace(/\.$/, "");
    if (host === undefined || host === "") return drop("page_out_of_scope");
    if (excluded(host)) return drop("page_excluded");
    const rule = ruleOf(tx, scope.rules, "block", block.app.bundle, host, undefined);
    const byDefault =
      rule === null &&
      defaultAdmits({ deny, boxHost: scope.boxHost }, block.app.bundle, host) &&
      !isSignInUrl(page.url) &&
      !isMultiAccount({ bundle: block.app.bundle, host });
    const compartment = rule?.compartment ?? (byDefault ? "own" : null);
    if (compartment === null) return drop("page_out_of_scope");
    if (compartment !== part.compartment) return drop("page_compartment");
    // An agent app's page is its conversation's title: agent output, never an observed fact.
    if (rule?.agent_app === true) return drop("page_agent_app");
    const texts = [page.title, page.query, ...pathOf(page.url)];
    if (texts.some((text) => text !== undefined && systemIdIn(text))) return drop("page_system_ids");
    if (recovery(texts)) return drop("page_recovery");
    if (screened([page.title, page.query], on).some((one) => !part.label.includes(one))) return drop("page_restricted");
    if ([page.title, page.query, pathText(page.url)].some((text) => text !== undefined && credentialShaped(text)))
      return drop("credential_shaped");
    return true;
  };
  const checked = parts.map((part) => ({
    part,
    blocks: part.item.blocks.map((block) => ({
      block,
      pages: (block.pages ?? []).filter((page) => passes(part, block, page)),
    })),
  }));
  const fpsOf = fpsMemo(tx.keys);
  const gone = await suppressedFps(
    tx.query,
    checked.flatMap((one) => one.blocks.flatMap((block) => block.pages.flatMap(fpsOf))),
  );
  for (const { part, blocks } of checked) {
    part.item = {
      ...part.item,
      blocks: blocks.map(({ block, pages }) => {
        const { kept, dropped: erased } = withoutNamed(pages, fpsOf, gone);
        if (erased > 0) tally(dropped, "page_erased", erased);
        const { pages: _pages, ...rest } = block;
        return kept.length === 0 ? rest : { ...rest, pages: kept };
      }),
    };
  }
}

// The drain of Lens's inbox: the pruning, then the selectable rows, each in a transaction of its own. Nothing is thrown for a row: a row whose transaction
// fails is rolled back, counted `failed` and not tried again in this run. A row that waits or fails
// is paged past, so `limit` counts the rows taken or dropped and no such row holds back a newer
// one.
export function takeCapture(writer: DrainContext, limit: number, options: DrainOptions = {}): Promise<CaptureCounts> {
  return writer.write(async () => {
    const { direct } = writer;
    await direct.query(PRUNE);
    const on = (
      await direct.query<{ category: RestrictedCategory }>(
        "select category from policy.restricted_categories order by category",
      )
    ).map((row) => row.category);
    const rules = await direct.query<Rule>(
      "select id, match, value_fp, account_fp, compartment, kinds, agent_app, source from policy.capture_scope order by id",
    );
    const excludes = new Set(
      (await direct.query<{ value_fp: string }>("select value_fp from policy.capture_excludes")).map(
        (row) => row.value_fp,
      ),
    );
    const accounts = new Map(
      (
        await direct.query<{ account_fp: string; compartment: string }>(
          "select account_fp, compartment from policy.capture_accounts",
        )
      ).map((row) => [row.account_fp, row.compartment]),
    );
    const deny = new Set(
      (
        await direct.query<{ id: string }>(
          "select capture_client_id as id from policy.lens_devices where browsing = 'deny'",
        )
      ).map((row) => row.id),
    );
    const scope: Scope = { rules, excludes, accounts, deny, boxHost: options.boxHost };
    const attributeRefused: Record<string, number> = {};
    const counts: CaptureCounts = { taken: 0, replaced: 0, dropped: {}, failed: 0, waiting: 0, attributeRefused };
    // One pass over the selectable rows of one kind group, a page at a time; it returns the rows
    // it took or dropped.
    const pass = async (tasks: boolean, budget: number): Promise<number> => {
      let after: { id: string; at: string } | null = null;
      let moved = 0;
      while (moved < budget) {
        const page: { id: string; at: string }[] = await direct.query<{ id: string; at: string }>(SELECTABLE, [
          budget - moved,
          after?.at ?? null,
          after?.id ?? null,
          tasks,
        ]);
        if (page.length === 0) break;
        for (const row of page) {
          after = row;
          let outcome: Outcome;
          try {
            outcome = await writer.write(() => writer.transaction((tx) => takeOne(tx, row.id, on, scope)));
          } catch (error) {
            // A lost connection or lock ends the run, as it ends takeRecords'.
            if (isCoded(error, "unavailable")) throw error;
            counts.failed += 1;
            continue;
          }
          if (outcome === "skipped") continue;
          if (outcome === "waiting") {
            counts.waiting += 1;
            continue;
          }
          moved += 1;
          if ("taken" in outcome) {
            counts[outcome.taken] += 1;
            for (const [code, count] of Object.entries(outcome.dropped ?? {})) tally(counts.dropped, code, count);
            if (outcome.byDefault !== undefined) counts.byDefault = (counts.byDefault ?? 0) + outcome.byDefault;
            if (outcome.meeting?.byDefault === true) counts.meetingsByDefault = (counts.meetingsByDefault ?? 0) + 1;
            if (outcome.meeting?.noAccount === true) counts.meetingsNoAccount = (counts.meetingsNoAccount ?? 0) + 1;
            if (outcome.blockRevisions !== undefined) {
              const total = (counts.blockRevisions ??= { grown: 0, changed: 0, tainted: 0 });
              total.grown += outcome.blockRevisions.grown;
              total.changed += outcome.blockRevisions.changed;
              total.tainted += outcome.blockRevisions.tainted;
            }
            for (const [code, count] of Object.entries(outcome.pageDropped ?? {})) tally(counts.dropped, code, count);
            for (const [method, count] of Object.entries(outcome.refused ?? {})) tally(attributeRefused, method, count);
          } else if (outcome.counts !== undefined)
            for (const [code, count] of Object.entries(outcome.counts)) tally(counts.dropped, code, count);
          else tally(counts.dropped, outcome.dropped);
        }
      }
      return moved;
    };
    // The other kinds first, then tasks.
    const moved = await pass(false, limit);
    await pass(true, limit - moved);
    return counts;
  });
}
