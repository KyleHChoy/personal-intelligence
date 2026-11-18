import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  AgentRecordItem,
  parseFillBody,
  parseOwnerAnswerBody,
  parsePersonProposalBody,
  parseProposalBody,
  proposalScope,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import { findAddresses, THE_OWNER } from "@intelligence/personal-core";
import { findStamps } from "@intelligence/personal-core/views";
import { stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId, sha256Hex } from "../core/ids.ts";
import { domainFp, fillDomain, fillIdentity, identityFp } from "../core/research.ts";
import { open, type Sealed, sealUnder } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";
import { TAINTED_HERE, taintCiting } from "../erasure/taint.ts";
import { suppressedFps } from "../identity/identity-port.ts";
import { marksOf } from "../memory/memory-marks.ts";
import { removeExtracted, removeRestrictions, removeUncited } from "./writer-removal.ts";

// Agent records in the vault: how one is emptied, how those resting on deleted evidence are found,
// and how one is taken in. Every transaction's first lock on an agent record is its evidence row,
// when it has one: the writer's deletion path, the owner's removal and the pipeline's commit, so
// two of them on one agent record meet at that row.

// The evidence rows of these agent records, then the rows themselves, `for update`, each in id
// order. Only rows that still have a body come back. An evidence id set between the first read
// and the lock, by an intake that committed meanwhile, is locked by the delete that follows.
export async function lockRecords(
  tx: Pick<Tx, "query">,
  ids: string[],
): Promise<{ id: string; evidence_id: string | null }[]> {
  const evidence = await tx.query<{ evidence_id: string }>(
    "select evidence_id from ledger.agent_writes where id = any($1) and evidence_id is not null",
    [ids],
  );
  if (evidence.length > 0) {
    await tx.query("select id from vault.evidence_items where id = any($1) order by id for update", [
      evidence.map((row) => row.evidence_id),
    ]);
  }
  return tx.query<{ id: string; evidence_id: string | null }>(
    "select id, evidence_id from ledger.agent_writes where id = any($1) and body_enc is not null order by id for update",
    [ids],
  );
}

// The one function that empties an agent record, under the caller's role, with no key: its body set
// to null and `tainted_at` to the database's now(), and its evidence row and blob deleted, with
// what was extracted from that evidence row. The row keeps its ids and its fingerprint. A row with
// no body is left as it is; the answer says whether anything was removed. What rests on its
// evidence row is tainted, after the beliefs lock and the evidence delete.
export async function removeOne(tx: Pick<Tx, "query">, recordId: string): Promise<boolean> {
  return (await emptyOne(tx, recordId, true)) !== false;
}

// removeOne's work; with `taint` false the caller taints the evidence id it answers, in its own
// one call, after its own deletes. It answers false when nothing was removed, else the agent
// record's evidence id, or null when it had none.
async function emptyOne(tx: Pick<Tx, "query">, recordId: string, taint: boolean): Promise<string | null | false> {
  const [row] = await lockRecords(tx, [recordId]);
  if (row === undefined) return false;
  if (row.evidence_id !== null) {
    const claimed = await removeExtracted(tx, [row.evidence_id]);
    await removeRestrictions(tx, [row.evidence_id]);
    const [evidence] = await tx.query<{ blob_ref: string }>(
      "delete from vault.evidence_items where id = $1 returning blob_ref",
      [row.evidence_id],
    );
    if (evidence !== undefined)
      await tx.query("delete from vault.evidence_blobs where blob_ref = $1", [evidence.blob_ref]);
    if (taint) await taintCiting(tx.query, { evidenceIds: [row.evidence_id], refs: [] });
    await removeUncited(tx, claimed);
  } else {
    // A note not yet taken in has no evidence row, so what cites it as the owner's
    // request is tainted by its id (invariant 10). Nothing else would taint it.
    await taintCiting(tx.query, { evidenceIds: [], refs: [{ kind: "owner_request", id: recordId }] });
  }
  await tx.query("update ledger.agent_writes set body_enc = null, tainted_at = now() where id = $1", [recordId]);
  return row.evidence_id;
}

// It runs before the deletion's taint call empties the projections' evidence ids.
export const RESTING = `
  select w.id from ledger.agent_writes w
  where w.body_enc is not null
    and (w.cites && $1::text[]
      or exists (select 1 from ledger.read_log r where r.session_id = w.session_id and r.read_at <= w.created_at and r.bound && $1::text[])
      or exists (select 1 from ledger.memory_imports m join ledger.memory_projections p on p.id = any (m.matched_projection_ids)
                 where m.record_id = w.id and p.evidence_ids && $1::text[]))
  order by w.id`;

// What removeSourceItem's second pass reads, after its taint call, which has emptied the evidence ids of the
// projections it tainted and stamped them with this transaction's time: so a memory change is found by those.
const RESTING_UNTAKEN = `
  select w.id from ledger.agent_writes w
  where w.body_enc is not null and w.evidence_id is null
    and (w.cites && $1::text[]
      or exists (select 1 from ledger.read_log r where r.session_id = w.session_id and r.read_at <= w.created_at and r.bound && $1::text[])
      or exists (select 1 from ledger.memory_imports m join ledger.memory_projections p on p.id = any (m.matched_projection_ids)
                 where m.record_id = w.id and ${TAINTED_HERE("p.tainted_at")}))
  order by w.id`;

// Every agent record resting on these evidence ids, emptied by removeRecords. One pass: no agent record
// rests on another. With `untaken`, only those with no evidence row: they have nothing of their own to
// taint.
export async function removeResting(
  tx: Tx,
  evidenceIds: string[],
  options?: { untaken: true },
): Promise<{ removed: number; evidenceIds: string[] }> {
  const resting = await tx.query<{ id: string }>(options?.untaken === true ? RESTING_UNTAKEN : RESTING, [evidenceIds]);
  return removeRecords(
    tx,
    resting.map((row) => row.id),
  );
}

// These agent records emptied as removeOne empties one, in the caller's transaction: how many,
// and their evidence ids, which the caller passes to its own one taint call so that the taint
// lock comes after its deletes. Their evidence rows are locked first, then their rows, before
// anything of theirs is removed.
export async function removeRecords(
  tx: Pick<Tx, "query">,
  ids: string[],
): Promise<{ removed: number; evidenceIds: string[] }> {
  if (ids.length === 0) return { removed: 0, evidenceIds: [] };
  await lockRecords(tx, ids);
  let removed = 0;
  const emptied: string[] = [];
  for (const id of ids) {
    const evidenceId = await emptyOne(tx, id, false);
    if (evidenceId === false) continue;
    removed += 1;
    if (evidenceId !== null) emptied.push(evidenceId);
  }
  return { removed, evidenceIds: emptied };
}

export type TakeCounts = { taken: number; removed: number; refused: number; waiting: number };

// The rows intake may select: a body, no evidence id, no code, and every compartment in the
// writer's keys; least recently tried first. The others that wait for a key are only counted.
const SELECTABLE = `
  select id from ledger.agent_writes
  where body_enc is not null and evidence_id is null and refused_code is null and compartments <@ $1::text[]
  order by coalesce(intake_tried_at, created_at), created_at, id limit $2`;
const WAITING = `
  select count(*)::int as waiting from ledger.agent_writes
  where body_enc is not null and evidence_id is null and refused_code is null and not (compartments <@ $1::text[])`;

type Selected = {
  id: string;
  client_id: string;
  client_name: string;
  session_id: string;
  kind: AgentRecordItem["kind"];
  created_at: Date;
  compartments: string[];
  content_fp: string;
  cites: string[];
  body_enc: Sealed | null;
  evidence_id: string | null;
  refused_code: string | null;
  proposal_scope: string | null;
  opportunity_id: string | null;
  fill_node: string | null;
  project_id: string | null;
};

const GONE = `
  with rests as (
    select unnest(w.cites) as id from ledger.agent_writes w where w.id = $1
    union
    select unnest(r.bound) from ledger.agent_writes w
    join ledger.read_log r on r.session_id = w.session_id and r.read_at <= w.created_at
    where w.id = $1)
  select exists (select 1 from rests where not exists (select 1 from vault.evidence_items e where e.id = rests.id)) as gone`;

// A stamp of another client's projection, or of none, is no stamp.
const TAINTED_STAMP = `
  select exists (select 1 from ledger.memory_projections p where p.id = any($1::text[]) and p.client_id = $2 and p.tainted_at is not null) as tainted`;

const MEMORY_MATCHED = `
  select coalesce(bool_or(p.tainted_at is not null), false) as tainted, coalesce(bool_or(p.ended_at is null), false) as live,
         count(*)::int as matched, min(p.first_served_at) as first_served_at
  from ledger.memory_projections p
  where p.client_id = $1 and (p.id = any($2::text[]) or p.line_fp = any($3::text[]))`;

type MemoryMark =
  | { mark: "refused" }
  | { mark: "new" | "echo" | "stale"; entryTime: Date | null; firstServedAt: Date | null };

// Intake's mark stands: it is written on the import row.
async function markMemory(tx: Tx, row: Selected, body: string): Promise<MemoryMark> {
  const { stamps, lineFps } = marksOf(tx.keys, body);
  const [found] = await tx.query<{ tainted: boolean; live: boolean; matched: number; first_served_at: Date | null }>(
    MEMORY_MATCHED,
    [row.client_id, stamps, lineFps],
  );
  const addresses = findAddresses(body).map((address) => fingerprint(tx.keys, "address", address));
  const suppressed = (await suppressedFps(tx, addresses)).size > 0;
  if (found === undefined || found.tainted || suppressed) return { mark: "refused" };
  const mark = found.live ? "echo" : found.matched > 0 ? "stale" : "new";
  const [imported] = await tx.query<{ entry_time: Date | null }>(
    "update ledger.memory_imports set mark = $2 where record_id = $1 returning entry_time",
    [row.id, mark],
  );
  return { mark, entryTime: imported?.entry_time ?? null, firstServedAt: found.first_served_at };
}

async function refuseMemory(tx: Tx, recordId: string): Promise<"removed" | "skipped"> {
  const removed = await removeOne(tx, recordId);
  await tx.query("update ledger.memory_imports set mark = 'refused', record_id = null where record_id = $1", [
    recordId,
  ]);
  return removed ? "removed" : "skipped";
}

const observedAt = (receipt: Date, mark: Exclude<MemoryMark, { mark: "refused" }>): Date =>
  new Date(
    Math.min(
      receipt.getTime(),
      ...[mark.entryTime, mark.firstServedAt].flatMap((at) => (at === null ? [] : [at.getTime()])),
    ),
  );

// One selected row, in the caller's transaction: removed, refused, taken, waiting for keys, or, when another
// transaction emptied or took it first, left as it is.
export async function takeOne(tx: Tx, recordId: string): Promise<keyof TakeCounts | "skipped"> {
  const [row] = await tx.query<Selected>(
    `select id, client_id, client_name, session_id, kind, created_at, compartments, content_fp, cites, body_enc, evidence_id, refused_code, proposal_scope, opportunity_id, fill_node, project_id
     from ledger.agent_writes where id = $1 for update`,
    [recordId],
  );
  if (row === undefined || row.body_enc === null || row.evidence_id !== null || row.refused_code !== null)
    return "skipped";
  const [rests] = await tx.query<{ gone: boolean }>(GONE, [recordId]);
  if (rests?.gone === true) {
    if (row.kind === "memory_change") return refuseMemory(tx, recordId);
    return (await removeOne(tx, recordId)) ? "removed" : "skipped";
  }

  const refuse = async (code: string): Promise<"refused"> => {
    await tx.query("update ledger.agent_writes set refused_code = $2 where id = $1", [recordId, code]);
    return "refused";
  };
  let body: string;
  try {
    body = open(tx.keys, row, "ledger.agent_writes.body_enc", "throw");
  } catch {
    // A missing or temporarily wrong key is not evidence that the record should be destroyed.
    // Rotate a failed opening behind older waiting work, including across process restarts.
    await tx.query("update ledger.agent_writes set intake_tried_at = clock_timestamp() where id = $1", [recordId]);
    return "waiting";
  }
  // A memory change is marked again at intake instead, its import row with it.
  let memory: Exclude<MemoryMark, { mark: "refused" }> | undefined;
  if (row.kind === "memory_change") {
    const marked = await markMemory(tx, row, body);
    if (marked.mark === "refused") return refuseMemory(tx, recordId);
    memory = marked;
  }
  const stamps = row.kind === "memory_change" ? [] : findStamps(body).map((one) => one.projection);
  if (stamps.length > 0) {
    const [found] = await tx.query<{ tainted: boolean }>(TAINTED_STAMP, [stamps, row.client_id]);
    if (found?.tainted === true) return (await removeOne(tx, recordId)) ? "removed" : "skipped";
  }
  const contentFp = fingerprint(tx.keys, "content_hash", sha256Hex(body));
  if (contentFp !== row.content_fp) return refuse("content_mismatch");
  // Or a propose_person body, of scope `all`. A statement proposal's scope is `all`.
  const proposal = row.kind === "proposal" ? parseProposalBody(body) : null;
  if (
    row.kind === "proposal" &&
    ((proposal === null ? undefined : proposalScope(proposal)) ??
      (parsePersonProposalBody(body) === null ? undefined : "all")) !== row.proposal_scope
  )
    return refuse("content_mismatch");
  // An answer's body is the answer body, strict, and answers the row's opportunity.
  if (row.kind === "answer" && parseOwnerAnswerBody(body)?.opportunity !== row.opportunity_id)
    return refuse("content_mismatch");
  const fill = row.kind === "fill" ? parseFillBody(body) : null;
  if (row.kind === "fill" && fill?.node !== row.fill_node) return refuse("content_mismatch");
  const [account] = await tx.query<{ id: string }>(
    "select id from vault.source_accounts where label = $1 and connector = 'agent'",
    [`agent:${row.client_name}`],
  );
  if (account === undefined) return refuse("no_account");

  // The evidence row, every column set explicitly.
  const source = {
    vault: "personal" as const,
    sourceAccount: SourceAccountId.parse(account.id),
    sourceItemId: `record:${row.id}`,
  };
  const evidenceId = evidenceIdFor({ ...source, revision: 0 });
  const item = AgentRecordItem.parse({
    recordId: row.id,
    client: row.client_name,
    session: row.session_id,
    kind: row.kind,
    recordedAt: stamp(row.created_at),
    cites: row.cites,
    ...(row.project_id === null ? {} : { project: row.project_id }),
    ...(memory === undefined
      ? {}
      : { memory: { ...(memory.entryTime === null ? {} : { entryTime: stamp(memory.entryTime) }), change: "added" } }),
  });
  const blobRef = newId("blb");
  await tx.query("insert into vault.evidence_blobs (blob_ref, envelope, compartments) values ($1, $2, $3)", [
    blobRef,
    // The body's UTF-8 bytes, base64, as every blob holds its payload.
    sealUnder(
      tx.keys,
      row.compartments,
      { table: "vault.evidence_blobs", id: blobRef, column: "envelope" },
      Buffer.from(body, "utf8").toString("base64"),
    ),
    row.compartments,
  ]);
  await tx.query(
    `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, supersedes, next_revision_id,
       thread_fp, content_hash, media_type, observed_at, change_kind, participant_members, sender_member, system_originated, answers_system,
       hold_released_at, blob_ref, payload_state, compartments, readers, item_enc, fill_identity_fp, fill_domain_fp)
     values ($1, $2, 'agent_record', $3, $4, 0, null, $5, null, $6, 'text/plain', $7, 'live', '{}', null, false, false, null, $8, 'present', $9, $10, $11, $12, $13)`,
    [
      evidenceId,
      account.id,
      fingerprint(tx.keys, "source_id", source.sourceItemId),
      fingerprint(tx.keys, "revision_tag", row.id),
      evidenceIdFor({ ...source, revision: 1 }),
      contentFp,
      memory === undefined ? row.created_at : observedAt(row.created_at, memory),
      blobRef,
      row.compartments,
      [THE_OWNER],
      sealUnder(
        tx.keys,
        row.compartments,
        { table: "vault.evidence_items", id: evidenceId, column: "item_enc" },
        JSON.stringify(item),
      ),
      fill === null || fillIdentity(fill.fill) === null ? null : identityFp(tx.keys, fillIdentity(fill.fill) as string),
      fill === null || fillDomain(fill.fill) === null ? null : domainFp(tx.keys, fillDomain(fill.fill) as string),
    ],
  );
  await tx.query("update ledger.agent_writes set evidence_id = $2 where id = $1", [recordId, evidenceId]);
  return "taken";
}

// What intake selects, and how many wait for a key, under the writer's keys.
export async function selectRecords(tx: Tx, limit: number): Promise<{ ids: string[]; waiting: number }> {
  const compartments = [...tx.keys.compartments.keys()];
  const ids = (await tx.query<{ id: string }>(SELECTABLE, [compartments, limit])).map((row) => row.id);
  const [counted] = await tx.query<{ waiting: number }>(WAITING, [compartments]);
  return { ids, waiting: counted?.waiting ?? 0 };
}
