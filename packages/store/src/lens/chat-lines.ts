import { randomBytes } from "node:crypto";
import { type MomentCaptureFacts, MomentItem } from "@intelligence/contracts/personal";
import { normalizeAddress, phoneKey, strictAddress } from "@intelligence/personal-core";
import { momentLines, sourceOwnerWord } from "@intelligence/personal-core/lens";
import type { Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { TRY_EXTRACT } from "../core/locks.ts";
import { open, type Sealed, sealUnder } from "../core/seal.ts";
import { sql } from "../core/sql.ts";
import { eachInOwnTransaction, type Tx } from "../core/tx.ts";
import { anySuppressed, holders } from "../core/vocabulary.ts";
import { countOf, type ErasureHook, peopleOf } from "../erasure/erasure-hook.ts";
import { removeWarmth } from "../identity/warmth-build.ts";
import { rewriteCaptureItem } from "./capture-item.ts";

// Each counted line of a source moment as a knowledge.chat_lines row, derived by code at each sync
// from the moment's sealed `lines` and the bindings the sync already makes, never from a model
// (invariant 5), and rebuilt from them (invariant 3). Only the warmth build reads the rows.
//
// Locks: the step runs inside `pi sync` under the sync lock, which every erasure and deletion at the
// source also holds, so none of them runs beside it. Its transaction for a moment takes the extract
// try-lock (as bindPhones' does: a run holding it makes the moment wait for the next sync), then the
// capture row `for update`, then, only when a row goes, the beliefs lock through removeWarmth. The
// warmth day build takes the beliefs lock and reads chat_lines without row locks, so it never waits on
// a capture row; removeSourceItem takes the capture row before the beliefs lock too: one order.

type LineCounts = {
  linesWritten: number;
  linesRemoved: number;
  noLines: number;
  notOwnerWord: number;
  ownerHandle: number;
  skipped: number;
};

// The derivation's version, in every fingerprint: a change to the rules below derives every moment
// again at the next sync. Each row also keeps the fingerprint it was resolved through
// (`handle_fp`).
const VERSION = "2";

// The moment row the step reads, as bindPhones reads it, with what the lines need.
export type LineMoment = {
  id: string;
  evidence_id: string;
  compartments: string[];
  ended_at: Date;
  thread_fp: string | null;
  lines_fp: string | null;
};

// A person, with the keyed fingerprint of the account they were found through: the phone key, the
// address a binding names, or the email address. It outlives a re-derive's new ids, so a kept line
// can be put back on whoever holds it then.
type Resolved = { kind: "person"; entity: string; via: string } | { kind: "owner" } | { kind: "nobody" };
const NOBODY: Resolved = { kind: "nobody" };

// Answers kept for one sync, by handle and label (a binding's, by evidence too). `unheld`: a phone
// key no one, or two, hold under the label, which the binding then decides.
export type LineMemo = Map<string, Promise<Resolved | "unheld">>;

// The ids of rows never served: a ULID with the time in it, after a prefix.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function chatLineId(): string {
  let time = Date.now();
  let head = "";
  for (let i = 0; i < 10; i += 1) {
    head = ALPHABET.charAt(time % 32) + head;
    time = Math.floor(time / 32);
  }
  let tail = "";
  for (const byte of randomBytes(16)) tail += ALPHABET.charAt(byte & 31);
  return `chl_${head}${tail}`;
}

// The entities holding an address or a phone key under the label: two or more is nobody.
const HOLDERS = sql`select a.entity_id, min(e.kind) as kind from ${holders("$1", "$2::text[]", "any")} group by a.entity_id order by a.entity_id collate "C" limit 2`;
// The people a live binding of the handle on this evidence names, through an account under the label.
const BOUND = `
  select a.entity_id, min(b.address_fp) as address_fp from knowledge.mention_bindings b
  join knowledge.accounts a on a.value_fp = b.address_fp
  join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
  where b.mention_fp = $1 and b.evidence_id = $3 and b.lifted_at is null and a.compartments <@ $2::text[]
  group by a.entity_id order by a.entity_id collate "C" limit 2`;
// A person known apart from source moments, within the label.
const KNOWN = `
  select (exists (select 1 from knowledge.contact_addresses k where k.entity_id = $1 and k.compartments <@ $2::text[])
    or exists (select 1 from knowledge.interaction_log i where i.entity_id = $1 and i.compartments <@ $2::text[])
    or exists (select 1 from knowledge.event_participants p where p.entity_id = $1 and p.compartments <@ $2::text[])) as yes`;

const memoized = <T extends Resolved | "unheld">(memo: LineMemo, key: string, answer: () => Promise<T>): Promise<T> => {
  let found = memo.get(key);
  if (found === undefined) {
    found = answer();
    memo.set(key, found);
  }
  return found as Promise<T>;
};

async function holder(query: Query, valueFp: string, label: readonly string[]): Promise<Resolved | null> {
  const rows = await query<{ entity_id: string; kind: string }>(HOLDERS, [valueFp, label]);
  const [one] = rows;
  if (one === undefined || rows.length > 1) return null;
  if (one.kind === "owner") return { kind: "owner" };
  return one.kind === "person" ? { kind: "person", entity: one.entity_id, via: valueFp } : NOBODY;
}

// One handle of one moment, under its label.
async function resolveHandle(
  tx: Tx,
  memo: LineMemo,
  handle: string,
  moment: Pick<LineMoment, "evidence_id" | "compartments">,
  ownerFps: ReadonlySet<string>,
): Promise<Resolved> {
  const label = [...moment.compartments].sort();
  const key = phoneKey(handle);
  if (key !== null) {
    const keyFp = fingerprint(tx.keys, "address", key);
    const nameFp = fingerprint(tx.keys, "name", handle);
    if (ownerFps.has(keyFp)) return { kind: "owner" };
    const keyed = await memoized<Resolved | "unheld">(memo, `key\n${keyFp}\n${label.join(",")}`, async () => {
      if (await anySuppressed(tx.query, [keyFp, nameFp])) return NOBODY;
      return (await holder(tx.query, keyFp, label)) ?? "unheld";
    });
    // Held by no one, or by two: the binding of this evidence decides, as the moment lane's port does.
    if (keyed !== "unheld") return keyed;
    return memoized<Resolved>(memo, `bound\n${nameFp}\n${moment.evidence_id}\n${label.join(",")}`, async () => {
      const rows = await tx.query<{ entity_id: string; address_fp: string }>(BOUND, [
        nameFp,
        label,
        moment.evidence_id,
      ]);
      const [one] = rows;
      return one === undefined || rows.length > 1
        ? NOBODY
        : { kind: "person", entity: one.entity_id, via: one.address_fp };
    });
  }
  const address = strictAddress(handle) ? normalizeAddress(handle) : null;
  if (address === null) return NOBODY;
  const addressFp = fingerprint(tx.keys, "address", address);
  if (ownerFps.has(addressFp)) return { kind: "owner" };
  return memoized<Resolved>(memo, `address\n${addressFp}\n${label.join(",")}`, async () => {
    if (await anySuppressed(tx.query, [addressFp])) return NOBODY;
    const found = await holder(tx.query, addressFp, label);
    if (found === null || found.kind !== "person") return found ?? NOBODY;
    return (await tx.query<{ yes: boolean }>(KNOWN, [found.entity, label]))[0]?.yes === true ? found : NOBODY;
  });
}

type Row = { line: number; entity: string; direction: "inbound" | "outbound"; at: string; handleFp: string };

// The rows a moment's lines give and their fingerprint; null for a moment that is no source chat.
async function linesOf(
  tx: Tx,
  memo: LineMemo,
  moment: LineMoment,
  facts: MomentCaptureFacts,
  ownerFps: ReadonlySet<string>,
): Promise<{ rows: Row[]; fp: string; others: number; refused: number; ownerHandles: number } | "no_lines" | null> {
  if (facts.kind !== "moment" || facts.entity !== "chat" || facts.source === undefined) return null;
  const lines = facts.lines;
  if (lines === undefined) return "no_lines";
  const resolved: Resolved[] = [];
  for (const handle of lines.handles)
    resolved.push(handle === null ? NOBODY : await resolveHandle(tx, memo, handle, moment, ownerFps));
  const others = lines.handles.filter((one) => one !== null).length;
  const ownWord = sourceOwnerWord(facts, moment.ended_at.toISOString());
  // Each person once, with the first handle they were found through, in the chat's order.
  const via = new Map<string, string>();
  for (const one of resolved) if (one.kind === "person" && !via.has(one.entity)) via.set(one.entity, one.via);
  const people = [...via.keys()].sort();
  const rows = new Map<string, Row>();
  let refused = 0;
  lines.turns.forEach(([who, at], line) => {
    if (moment.thread_fp === null || others === 0) return;
    if (who === -1) {
      if (!ownWord) {
        refused += 1;
        return;
      }
      for (const entity of people)
        rows.set(`${line}\n${entity}`, {
          line,
          entity,
          direction: "outbound",
          at,
          handleFp: via.get(entity) as string,
        });
      return;
    }
    const one = resolved[who];
    if (one?.kind === "person")
      rows.set(`${line}\n${one.entity}`, {
        line,
        entity: one.entity,
        direction: "inbound",
        at,
        handleFp: via.get(one.entity) as string,
      });
  });
  const fp = fingerprint(
    tx.keys,
    "chat_lines",
    [
      VERSION,
      moment.evidence_id,
      moment.thread_fp ?? "-",
      String(others),
      ownWord ? "word" : "-",
      ...resolved.map((one) => (one.kind === "person" ? `${one.entity}:${one.via}` : one.kind)),
    ].join("\n"),
  );
  return {
    rows: [...rows.values()],
    fp,
    others,
    refused,
    ownerHandles: resolved.filter((one) => one.kind === "owner").length,
  };
}

// A row as knowledge.chat_lines holds it.
type HeldLine = {
  id: string;
  line: number;
  entity_id: string;
  direction: string;
  occurred_at: Date;
  others: number;
  thread_fp: string | null;
  handle_fp: string | null;
};
type LineSays = {
  line: number;
  entity: string;
  direction: string;
  at: number;
  others: number;
  thread: string | null;
  handle: string | null;
};
const heldSays = (one: HeldLine): LineSays => ({
  line: one.line,
  entity: one.entity_id,
  direction: one.direction,
  at: one.occurred_at.getTime(),
  others: one.others,
  thread: one.thread_fp,
  handle: one.handle_fp,
});
const rowSays = (one: Row, others: number, thread: string | null): LineSays => ({
  line: one.line,
  entity: one.entity,
  direction: one.direction,
  at: Date.parse(one.at),
  others,
  thread,
  handle: one.handleFp,
});
// Everything a row says, with or without the handle it was resolved through.
const keyOf = (one: LineSays, withHandle: boolean): string =>
  `${one.line}\n${one.entity}\n${one.direction}\n${one.at}\n${one.others}\n${one.thread}${withHandle ? `\n${one.handle}` : ""}`;

// The held rows that go and the derived rows added. A row is kept only when everything it says is
// unchanged: an erasure that drops a person's turns shifts the later lines' places, so a place can
// name another line now. The chat's size and thread are part of what a row says (its `n`): an
// erasure that drops the last speaker's turns shifts no place but changes `others`, and a row has
// no update grant, so a row with a stale size is gone and its replacement added. So is the handle a
// row was resolved through, so a row written before handles were kept (or through a handle since
// changed) is written again with it. `meaningLost`: a gone row says something no derived row still
// says; a row rewritten only to gain or change its handle says the same as before, so it removes
// no warmth (a rewrite of every row to gain its handle would otherwise empty every label's days).
function lineChanges(
  old: readonly HeldLine[],
  rows: readonly Row[],
  others: number,
  thread: string | null,
): { gone: HeldLine[]; added: Row[]; meaningLost: boolean } {
  const derived = rows.map((one) => rowSays(one, others, thread));
  const wanted = new Set(derived.map((one) => keyOf(one, true)));
  const held = new Set(old.map((one) => keyOf(heldSays(one), true)));
  const gone = old.filter((one) => !wanted.has(keyOf(heldSays(one), true)));
  const added = rows.filter((_one, index) => !held.has(keyOf(derived[index] as LineSays, true)));
  const stillMeant = new Set(derived.map((one) => keyOf(one, false)));
  return { gone, added, meaningLost: gone.some((one) => !stillMeant.has(keyOf(heldSays(one), false))) };
}

// A moment's new rows in one statement; a row already there is kept.
const INSERT = `
  insert into knowledge.chat_lines (id, evidence_id, line, entity_id, direction, occurred_at, others, thread_fp, compartments, handle_fp)
  select r.id, $1, r.line, r.entity_id, r.direction, r.occurred_at, $2, $3, $4::text[], r.handle_fp
  from jsonb_to_recordset($5::jsonb) as r (id text, line integer, entity_id text, direction text, occurred_at timestamptz, handle_fp text)
  on conflict (evidence_id, line, entity_id) do nothing`;

// One moment's rows brought to what its lines give now, when its fingerprint changed.
export async function deriveChatLines(
  writer: { direct: Tx; transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> },
  memo: LineMemo,
  moment: LineMoment,
  facts: MomentCaptureFacts,
  ownerFps: ReadonlySet<string>,
  counts: LineCounts,
): Promise<void> {
  const derived = await linesOf(writer.direct, memo, moment, facts, ownerFps);
  if (derived === null) return;
  if (derived === "no_lines") {
    counts.noLines += 1;
    // Facts sealed without lines: a fingerprint of their having none, so the null-fingerprint reach
    // does not read them at every sync; the lines catch-up reseals them and nulls it again.
    const none = fingerprint(writer.direct.keys, "chat_lines", [VERSION, moment.evidence_id, "none"].join("\n"));
    if (moment.lines_fp !== none)
      await writer.direct.query("update knowledge.captures set lines_fp = $2 where id = $1 and evidence_id = $3", [
        moment.id,
        none,
        moment.evidence_id,
      ]);
    return;
  }
  if (derived.fp === moment.lines_fp) return;
  await writer.transaction(async (tx) => {
    const [lock] = await tx.query<{ held: boolean }>(TRY_EXTRACT);
    if (lock?.held !== true) {
      counts.skipped += 1;
      return;
    }
    const [row] = await tx.query<{ lines_fp: string | null }>(
      "select lines_fp from knowledge.captures where id = $1 and evidence_id = $2 for update",
      [moment.id, moment.evidence_id],
    );
    if (row === undefined || row.lines_fp === derived.fp) return;
    const old = await tx.query<HeldLine>(
      "select id, line, entity_id, direction, occurred_at, others, thread_fp, handle_fp from knowledge.chat_lines where evidence_id = $1",
      [moment.evidence_id],
    );
    const { gone, added, meaningLost } = lineChanges(old, derived.rows, derived.others, moment.thread_fp);
    if (gone.length > 0) {
      await tx.query("delete from knowledge.chat_lines where id = any($1::text[])", [gone.map((one) => one.id)]);
      // A line that stopped counting never keeps a tier up until the daily build.
      if (meaningLost) {
        await removeWarmth(tx.query, [moment.compartments]);
      }
      counts.linesRemoved += gone.length;
    }
    if (added.length > 0) {
      await tx.query(INSERT, [
        moment.evidence_id,
        derived.others,
        moment.thread_fp,
        moment.compartments,
        JSON.stringify(
          added.map((one) => ({
            id: chatLineId(),
            line: one.line,
            entity_id: one.entity,
            direction: one.direction,
            occurred_at: one.at,
            handle_fp: one.handleFp,
          })),
        ),
      ]);
      counts.linesWritten += added.length;
    }
    await tx.query("update knowledge.captures set lines_fp = $2 where id = $1", [moment.id, derived.fp]);
    counts.notOwnerWord += derived.refused;
    counts.ownerHandle += derived.ownerHandles;
  });
}

// ---------------------------------------------------------------------------------------------
// The catch-up: `pi-sync capture lines-backfill`
// ---------------------------------------------------------------------------------------------

export type LinesBackfill = { moments: number; missing: number; filled: number; failed: number };

const at = (id: string) => ({ table: "knowledge.captures", id, column: "facts_enc" });

// Every stored source moment whose facts lack `lines` has them derived again from its
// stored item (the evidence blob the moment lane opens, which keeps every turn with its sender and
// time) and sealed again, in its facts and in its evidence row's copy, its `lines_fp` set null so
// the next sync derives its rows. Idempotent: a moment with lines is passed over. A dry run counts.
// A moment whose payload has expired is passed over: its text is gone, and its rows are never
// derived again.
export async function backfillChatLines(
  writer: { direct: Tx; transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> },
  options: { dryRun: boolean },
): Promise<LinesBackfill> {
  const { direct } = writer;
  const rows = await direct.query<{ id: string; evidence_id: string; compartments: string[]; facts_enc: Sealed }>(
    `select c.id, c.evidence_id, c.compartments, c.facts_enc
     from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id
     where c.kind = 'moment' and c.source is not null and e.payload_state = 'present' and e.blob_ref is not null
     order by c.id`,
  );
  const done: LinesBackfill = { moments: rows.length, missing: 0, filled: 0, failed: 0 };
  done.failed = await eachInOwnTransaction(rows, async (row) => {
    const facts = JSON.parse(open(direct.keys, row, "knowledge.captures.facts_enc", "throw")) as MomentCaptureFacts;
    if (facts.lines !== undefined) return;
    done.missing += 1;
    if (options.dryRun) return;
    await writer.transaction(async (tx) => {
      const [locked] = await tx.query<{
        facts_enc: Sealed;
        blob_ref: string | null;
        item_compartments: string[];
        item_enc: Sealed;
      }>(
        `select c.facts_enc, e.blob_ref, e.compartments as item_compartments, e.item_enc
         from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id
         where c.id = $1 and c.evidence_id = $2 for update of c, e`,
        [row.id, row.evidence_id],
      );
      if (locked?.blob_ref === null || locked === undefined) return;
      const current = JSON.parse(
        open(tx.keys, { ...row, facts_enc: locked.facts_enc }, "knowledge.captures.facts_enc", "throw"),
      ) as MomentCaptureFacts;
      if (current.lines !== undefined) return;
      const [blob] = await tx.query<{ envelope: Sealed }>(
        "select envelope from vault.evidence_blobs where blob_ref = $1",
        [locked.blob_ref],
      );
      const json = Buffer.from(
        open(
          tx.keys,
          { id: locked.blob_ref, compartments: locked.item_compartments, envelope: blob?.envelope },
          "vault.evidence_blobs.envelope",
          "throw",
        ),
        "base64",
      ).toString("utf8");
      const lines = momentLines(MomentItem.parse(JSON.parse(json)));
      if (lines === undefined) return;
      await tx.query("update knowledge.captures set facts_enc = $2, lines_fp = null where id = $1", [
        row.id,
        sealUnder(tx.keys, row.compartments, at(row.id), JSON.stringify({ ...current, lines })),
      ]);
      const item = JSON.parse(
        open(
          tx.keys,
          { id: row.evidence_id, compartments: locked.item_compartments, item_enc: locked.item_enc },
          "vault.evidence_items.item_enc",
          "throw",
        ),
      ) as MomentCaptureFacts;
      if (item.kind === "moment" && item.lines === undefined) {
        await rewriteCaptureItem(
          tx.query,
          tx.keys,
          { evidenceId: row.evidence_id, compartments: locked.item_compartments },
          { ...item, lines },
        );
      }
      done.filled += 1;
    });
  });
  return done;
}

// An erased person's chat lines, every one, whatever moment they came from. A moment's text may
// have expired while its lines were kept, so the step can never derive it again to drop them, and
// the person's entity may survive `removeUncited`; so the erasure deletes the lines itself, nulls
// the `lines_fp` of the moments still held so the others' rows are derived again, and removes the
// warmth days of every label that could see one.
export const chatLinesErasure: ErasureHook = {
  name: "chat_lines",
  async run(query, erased, { dryRun }) {
    const people = peopleOf(erased);
    if (people.length === 0) return 0;
    if (dryRun)
      return countOf(query, "select count(*)::int as n from knowledge.chat_lines where entity_id = any($1::text[])", [
        people,
      ]);
    const gone = await query<{ evidence_id: string; compartments: string[] }>(
      "delete from knowledge.chat_lines where entity_id = any($1::text[]) returning evidence_id, compartments",
      [people],
    );
    if (gone.length === 0) return 0;
    await query("update knowledge.captures set lines_fp = null where evidence_id = any($1::text[])", [
      [...new Set(gone.map((row) => row.evidence_id))],
    ]);
    await removeWarmth(
      query,
      gone.map((row) => row.compartments),
    );
    return gone.length;
  },
};
