import type { EvidenceId, Timestamp } from "@intelligence/contracts";
import {
  AgentRecordItem,
  type BacklogItem,
  CodedError,
  DocumentKind,
  type DueCursor,
  type DueDocument,
  type DueItem,
  type EmailDueItem,
  MessageCategory,
  type MessageTriageRow,
  PersonalEvidenceId,
} from "@intelligence/contracts/personal";
import { byText, sqlstateOf, stamp } from "../core/db.ts";
import { dueWhen, EXTRACTION_LANES } from "../core/lanes.ts";
import { open, type Sealed } from "../core/seal.ts";
import { openStatus } from "../core/status-facts.ts";
import type { Tx } from "../core/tx.ts";
import { knownCorrespondent } from "../core/vocabulary.ts";
import { dueStatus, sourceCompartment } from "./pipeline-read.ts";

// The pipeline's due queue and backlogs for messages, agent records and documents, with triage's
// lane rank. Nothing here writes but
// `markRecovery`, the recovery backlog's mark.

// The source kinds extraction knows: every extraction lane's but documents', which are read by
// `dueDocuments`. Meetings' `transcript` and moments' `screen_activity` are read by `dueCaptures`,
// ordered by observed_at; a `time_block` never joins it.
const DUE_KINDS = Object.values(EXTRACTION_LANES)
  .map((lane) => lane.kind)
  .filter((kind) => kind !== EXTRACTION_LANES.document.kind);

type DueRow = {
  source: "email" | "agent_record";
  evidence_id: string;
  compartments: string[];
  sent_at: Date;
  direction: "inbound" | "outbound" | null;
  bulk: boolean | null;
  category: string | null;
  message_id: string | null;
  message_facts: Sealed | null;
  item_enc: Sealed | null;
  status_facts: Sealed | null;
  // The sender is someone the owner corresponds with (`knownCorrespondent`); the
  // due order's and the recovery backlog's, read in the statement.
  known_correspondent?: boolean | null;
  // The due order's alone; the backlog reads items at the run's generation.
  regenerated?: boolean;
};

// An agent record done since, with a release in force (`r`, a row of policy.released_records) and
// no released claim, is due again, so the owner's confirmation is built into its released claim at
// the next run. A record skipped or withheld is not: it built no claim to release. It is due while
// the release in force is not the one its last run read (`release_ruling_id`, set at the commit
// from what the run opened), so a confirm that lands during a run is built at the next, and a run
// that read it is not due again, claim or none.
const UNBUILT_RELEASE = `(r.evidence_id is not null and p.screened and not p.withheld and p.release_ruling_id is distinct from r.ruling_id)`;

// The lane triage gives a row from its stored columns, as a rank: 0 correspondence (outbound, or
// inbound not bulk), 1 transaction (bulk Updates or Primary), 2 the rest. Triage's other tests read
// sealed facts and the owner's lane is sealed, so neither moves an item: a row that triage skips
// for no text, or that the owner set to another lane, keeps the rank of its columns.
const laneRank = (m: string): string =>
  `(case when ${m}.direction = 'outbound' or not ${m}.bulk then 0 when ${m}.category in ('updates', 'primary') then 1 else 2 end)`;

// The same rank, of a cursor's triage row.
const cursorRank = ({ direction, bulk, category }: MessageTriageRow): number =>
  direction === "outbound" || !bulk ? 0 : category === "updates" || category === "primary" ? 1 : 2;

// A page's cursor is its last item, with its rank. A withheld row that is not waiting is not due
// for a generation change: only the owner's retry runs it again. The agent branch is a union with
// the message branch, ordered and paged with it: an agent record's sent time is its evidence row's
// observed_at, its rank that of the rest (2), and it reads nothing in `ledger`. The known
// correspondent fact is read for the page alone, after the limit; an agent record's is null.
const DUE = `
  select d.*, ${knownCorrespondent("d")} as known_correspondent from (
    select u.* from (
      select 'email' as source, e.id as evidence_id, e.compartments, m.sent_at, m.direction, m.bulk, m.category, m.id as message_id,
        m.sender_fp, m.facts_enc as message_facts, null::jsonb as item_enc, p.facts_enc as status_facts,
        coalesce(p.extractor_generation <> $2, false) as regenerated, ${laneRank("m")} as rank
      from knowledge.messages m
      join vault.evidence_items e on e.id = m.evidence_id
      left join vault.pipeline_items p on p.evidence_id = e.id
      where e.source_kind = any ($1::text[]) and not m.held
        and ${dueWhen("$2")}
        and ($3::text[] is null or e.compartments <@ $3::text[])
      union all
      select 'agent_record', e.id, e.compartments, e.observed_at, null, null, null, null, null, null, e.item_enc, p.facts_enc,
        coalesce(p.extractor_generation <> $2, false), 2
      from vault.evidence_items e
      left join vault.pipeline_items p on p.evidence_id = e.id
      left join (select r.evidence_id, r.ruling_id from policy.released_records() r) r on r.evidence_id = e.id
      -- A typed finding's record is never due; its claims were written with no model.
      where e.source_kind = 'agent_record' and e.source_kind = any ($1::text[]) and not e.typed
        and (${dueWhen("$2")} or ${UNBUILT_RELEASE})
        and ($3::text[] is null or e.compartments <@ $3::text[])
    ) u
    where ($4::timestamptz is null or u.rank > $7::int or (u.rank = $7::int
      and (u.sent_at < $4::timestamptz or (u.sent_at = $4::timestamptz and u.evidence_id collate "C" > $5::text))))
    order by u.rank, u.sent_at desc, u.evidence_id collate "C"
    limit $6
  ) d
  order by d.rank, d.sent_at desc, d.evidence_id collate "C"`;

// What triage reads of a message's sealed facts: `unreadable` and `chars`, every other key
// ignored. A row whose JSON lacks either reads as one with no text.
function triageFacts(text: string): { unreadable: boolean; chars: number } {
  const facts = JSON.parse(text) as { unreadable?: unknown; chars?: unknown };
  const { unreadable, chars } = facts;
  if (typeof unreadable !== "boolean" || typeof chars !== "number" || !Number.isSafeInteger(chars) || chars < 0)
    return { unreadable: true, chars: 0 };
  return { unreadable, chars };
}

// One row of DUE or BACKLOG as the pipeline reads it, under its row's whole label.
function dueOf(tx: Tx, row: DueRow): DueItem {
  const compartments = [...row.compartments].sort(byText);
  const status =
    row.status_facts === null ? undefined : openStatus(tx, row.compartments, row.evidence_id, row.status_facts);
  const common = {
    evidenceId: PersonalEvidenceId.parse(row.evidence_id),
    compartments,
    sentAt: stamp(row.sent_at),
    attempts: status?.attempts ?? 0,
    override: status?.override === true,
    // Or set waiting by the owner's reroute, a re-read of old mail. The due order's alone: the
    // backlogs read no `regenerated`.
    ...(row.regenerated === true || (row.regenerated !== undefined && status?.rerouted === true)
      ? { regenerated: true as const }
      : {}),
  };
  if (row.source === "agent_record") {
    // An agent record's kind, from its sealed item. No owner's lane: its lane is `agent`.
    const item = AgentRecordItem.parse(
      JSON.parse(
        open(
          tx.keys,
          { id: row.evidence_id, compartments: row.compartments, item_enc: row.item_enc },
          "vault.evidence_items.item_enc",
          "throw",
        ),
      ),
    );
    return { source: "agent_record", ...common, kind: item.kind };
  }
  const message = triageFacts(
    open(
      tx.keys,
      { id: row.message_id ?? "", compartments: row.compartments, facts_enc: row.message_facts },
      "knowledge.messages.facts_enc",
      "throw",
    ),
  );
  const triage: MessageTriageRow = {
    direction: row.direction ?? "inbound",
    bulk: row.bulk === true,
    category: MessageCategory.parse(row.category),
    ...message,
    ...(row.known_correspondent === true ? { knownCorrespondent: true as const } : {}),
  };
  return {
    source: "email",
    ...common,
    ...(status?.laneOverride === undefined ? {} : { lane: status.laneOverride }),
    ...(status?.ask === undefined ? {} : { ask: status.ask }),
    triage,
  };
}

// For the decide model's review: what triage reads of one stored message, for re-rendering the slot a
// decide-model call was shown. Null when the item has no message row.
export async function triageRowOf(tx: Tx, evidenceId: string): Promise<MessageTriageRow | null> {
  const [row] = await tx.query<{
    id: string;
    direction: "inbound" | "outbound";
    bulk: boolean;
    category: string;
    facts_enc: Sealed;
    compartments: string[];
    known_correspondent: boolean;
  }>(
    `select m.id, m.direction, m.bulk, m.category, m.facts_enc, m.compartments, ${knownCorrespondent("m")} as known_correspondent from knowledge.messages m where m.evidence_id = $1`,
    [evidenceId],
  );
  if (row === undefined) return null;
  const message = triageFacts(open(tx.keys, row, "knowledge.messages.facts_enc", "throw"));
  return {
    direction: row.direction,
    bulk: row.bulk,
    category: MessageCategory.parse(row.category),
    ...message,
    ...(row.known_correspondent ? { knownCorrespondent: true as const } : {}),
  };
}

export async function dueItems(
  tx: Tx,
  limit: number,
  generation: number,
  options?: { compartments?: string[]; after?: DueCursor; agentRecords?: true },
): Promise<DueItem[]> {
  const rows = await tx.query<DueRow>(DUE, [
    // The proposal wake's run takes agent records alone.
    options?.agentRecords === true ? ["agent_record"] : [...DUE_KINDS],
    generation,
    options?.compartments ?? null,
    options?.after?.sentAt ?? null,
    options?.after?.evidenceId ?? null,
    limit,
    options?.after === undefined ? null : options.after.triage === undefined ? 2 : cursorRank(options.after.triage),
  ]);
  return rows.map((row) => dueOf(tx, row));
}

// The backlog: rows at this generation, neither waiting nor withheld, whose item's revision has no
// saved call of the prompt, whatever the model. The status, its code and the owner's marks are
// sealed, so done and bulk-skipped rows the owner did not give both a lane and a release are picked
// in code, before the limit. Messages only.
const BACKLOG = `
  select 'email' as source, e.id as evidence_id, e.compartments, m.sent_at, m.direction, m.bulk, m.category, m.id as message_id,
    m.facts_enc as message_facts, null::jsonb as item_enc, p.facts_enc as status_facts
  from knowledge.messages m
  join vault.evidence_items e on e.id = m.evidence_id
  join vault.pipeline_items p on p.evidence_id = e.id
  where e.source_kind = 'email' and e.source_kind = any ($1::text[]) and not m.held
    and p.extractor_generation = $2 and not p.waiting and not p.withheld
    and $6::boolean = exists (select 1 from vault.model_calls c
      where c.evidence_id = e.id and c.revision = e.revision and c.prompt_id = $3 and c.prompt_version = $4
        and c.superseded_at is null)
    and ($5::text[] is null or e.compartments <@ $5::text[])
  order by m.sent_at desc, e.id collate "C"`;

// Of these messages' evidence ids, those whose sender the owner corresponds with.
async function knownOf(tx: Tx, evidenceIds: readonly string[]): Promise<Set<string>> {
  if (evidenceIds.length === 0) return new Set();
  const rows = await tx.query<{ evidence_id: string }>(
    `select m.evidence_id from knowledge.messages m where m.evidence_id = any ($1) and ${knownCorrespondent("m")}`,
    [evidenceIds],
  );
  return new Set(rows.map((row) => row.evidence_id));
}

export async function backlogItems(
  tx: Tx,
  limit: number,
  generation: number,
  prompt: { promptId: string; promptVersion: string },
  options?: { compartments?: string[]; saved?: boolean },
): Promise<BacklogItem[]> {
  const rows = await tx.query<DueRow>(BACKLOG, [
    [...DUE_KINDS],
    generation,
    prompt.promptId,
    prompt.promptVersion,
    options?.compartments ?? null,
    options?.saved === true,
  ]);
  const found: BacklogItem[] = [];
  for (const row of rows) {
    if (found.length >= limit) break;
    const status = openStatus(tx, row.compartments, row.evidence_id, row.status_facts);
    // With the owner's lane and release both set, the decide model has nothing to decide.
    if (status.laneOverride !== undefined && status.override) continue;
    const due = dueOf(tx, row);
    if (due.source !== "email") continue;
    if (status.status === "done" || (status.status === "skipped" && status.code === "bulk"))
      found.push({ ...due, committedLane: status.lane });
  }
  const known = await knownOf(
    tx,
    found.map((item) => item.evidenceId),
  );
  return found.map((item) =>
    known.has(item.evidenceId) ? { ...item, triage: { ...item.triage, knownCorrespondent: true as const } } : item,
  );
}

// The agent lane's trial: the newest findings done at this generation, as the backlog reads
// messages. A typed finding's record is never due, so never here. The kind and status are sealed, so
// they are picked in code, before the limit.
const FINDING_BACKLOG = `
  select 'agent_record' as source, e.id as evidence_id, e.compartments, e.observed_at as sent_at, null as direction, null as bulk,
    null as category, null as message_id, null as message_facts, e.item_enc, p.facts_enc as status_facts
  from vault.evidence_items e
  join vault.pipeline_items p on p.evidence_id = e.id
  where e.source_kind = 'agent_record' and not e.typed
    and p.extractor_generation = $1 and not p.waiting and not p.withheld
    and $4::boolean = exists (select 1 from vault.model_calls c
      where c.evidence_id = e.id and c.revision = e.revision and c.prompt_id = $2 and c.prompt_version = $3
        and c.superseded_at is null)
    and ($5::text[] is null or e.compartments <@ $5::text[])
  order by e.observed_at desc, e.id collate "C"`;

export async function findingBacklogItems(
  tx: Tx,
  limit: number,
  generation: number,
  prompt: { promptId: string; promptVersion: string },
  options?: { compartments?: string[]; saved?: boolean },
): Promise<Extract<DueItem, { source: "agent_record" }>[]> {
  const rows = await tx.query<DueRow>(FINDING_BACKLOG, [
    generation,
    prompt.promptId,
    prompt.promptVersion,
    options?.saved === true,
    options?.compartments ?? null,
  ]);
  const found: Extract<DueItem, { source: "agent_record" }>[] = [];
  for (const row of rows) {
    if (found.length >= limit) break;
    const due = dueOf(tx, row);
    if (due.source !== "agent_record" || due.kind !== "finding") continue;
    if (openStatus(tx, row.compartments, row.evidence_id, row.status_facts).status === "done") found.push(due);
  }
  return found;
}

// `pi extract refusals`: the messages with a refused candidate, as the backlog reads a message, done
// at this generation. Nothing is opened but what the backlog opens.
const REFUSED = `
  select 'email' as source, e.id as evidence_id, e.compartments, m.sent_at, m.direction, m.bulk, m.category, m.id as message_id,
    m.facts_enc as message_facts, null::jsonb as item_enc, p.facts_enc as status_facts
  from knowledge.messages m
  join vault.evidence_items e on e.id = m.evidence_id
  join vault.pipeline_items p on p.evidence_id = e.id
  where e.source_kind = 'email' and not m.held
    and p.extractor_generation = $1 and not p.waiting and not p.withheld
    and exists (select 1 from vault.unmapped_claims u where u.evidence_id = e.id)
    and ($2::text[] is null or e.compartments <@ $2::text[])
  order by m.sent_at desc, e.id collate "C"
  limit $3`;

export async function refusedItems(
  tx: Tx,
  limit: number,
  generation: number,
  options?: { compartments?: string[] },
): Promise<BacklogItem[]> {
  const rows = await tx.query<DueRow>(REFUSED, [generation, options?.compartments ?? null, limit]);
  return rows.flatMap((row) => {
    const status = openStatus(tx, row.compartments, row.evidence_id, row.status_facts);
    const due = dueOf(tx, row);
    return due.source === "email" && status.status === "done" ? [{ ...due, committedLane: status.lane }] : [];
  });
}

// The recovery backlog: stored email items, latest revision (a message row cites its latest), not
// held and never released, with no recovery mark, newest first. It reads the partial index on
// recovery_screened_at.
const RECOVERY_BACKLOG = `
  select 'email' as source, e.id as evidence_id, e.compartments, m.sent_at, m.direction, m.bulk, m.category, m.id as message_id,
    m.facts_enc as message_facts, null::jsonb as item_enc, p.facts_enc as status_facts, ${knownCorrespondent("m")} as known_correspondent
  from knowledge.messages m
  join vault.evidence_items e on e.id = m.evidence_id
  left join vault.pipeline_items p on p.evidence_id = e.id
  where e.source_kind = 'email' and not m.held and e.hold_released_at is null and e.recovery_screened_at is null
    and ($1::text[] is null or e.compartments <@ $1::text[])
  order by m.sent_at desc, e.id collate "C"
  limit $2`;

// One call of vault.mark_recovery, which locks the message row and then the evidence row, refuses
// a row rewritten since `open` read it (its xmin in `seen`), and holds only the latest revision of
// a message the owner never released. The mark rewrites the evidence row, so its new xmin goes into
// `seen`, which `commit` and `calls.save` compare from here on.
export async function markRecovery(
  tx: Tx,
  evidenceId: string,
  hold: boolean,
  seen: Map<string, string>,
): Promise<boolean> {
  let held: boolean;
  try {
    held =
      (
        await tx.query<{ held: boolean }>("select vault.mark_recovery($1, $2, $3) as held", [
          evidenceId,
          hold,
          seen.get(evidenceId) ?? null,
        ])
      )[0]?.held === true;
  } catch (error) {
    if (sqlstateOf(error) === "PIC01") throw new CodedError("item_changed");
    throw error;
  }
  const [row] = await tx.query<{ xmin: string }>("select xmin::text as xmin from vault.evidence_items where id = $1", [
    evidenceId,
  ]);
  if (row !== undefined && seen.has(evidenceId)) seen.set(evidenceId, row.xmin);
  return held;
}

export async function recoveryBacklogItems(
  tx: Tx,
  limit: number,
  options?: { compartments?: string[] },
): Promise<EmailDueItem[]> {
  const rows = await tx.query<DueRow>(RECOVERY_BACKLOG, [options?.compartments ?? null, limit]);
  return rows.map((row) => dueOf(tx, row) as EmailDueItem);
}

type DueDocumentRow = {
  evidence_id: string;
  compartments: string[];
  modified_at: Date;
  kind: string;
  mine: boolean;
  edited_by_me: boolean;
  reference: boolean;
  document_id: string;
  document_facts: Sealed;
  status_facts: Sealed | null;
};

// As for a message, a withheld row that is not waiting is not due for a generation change. Whether
// documents are taken at all is the caller's.
const DUE_DOCUMENTS = `
  select e.id as evidence_id, e.compartments, d.modified_at, d.kind, d.mine, d.edited_by_me, d.reference, d.id as document_id,
    d.facts_enc as document_facts, p.facts_enc as status_facts
  from knowledge.documents d
  join vault.evidence_items e on e.id = d.evidence_id
  left join vault.pipeline_items p on p.evidence_id = e.id
  where e.source_kind = 'document' and not d.held and d.modified_at <= $1::timestamptz
    and ${dueWhen("$2")}
    and ($3::text[] is null or e.compartments <@ $3::text[])
    and ($4::timestamptz is null or d.modified_at < $4::timestamptz or (d.modified_at = $4::timestamptz and e.id collate "C" > $5::text))
  order by d.modified_at desc, e.id collate "C"
  limit $6`;

// What triage reads of a document's sealed facts: whether it has text and how much. A row whose
// JSON lacks either reads as one with no text.
function documentTriageFacts(text: string): { unreadable: boolean; chars: number } {
  const { unreadable, chars } = JSON.parse(text) as { unreadable?: unknown; chars?: unknown };
  if (
    (unreadable !== null && typeof unreadable !== "string") ||
    typeof chars !== "number" ||
    !Number.isSafeInteger(chars) ||
    chars < 0
  )
    return { unreadable: true, chars: 0 };
  return { unreadable: unreadable !== null, chars };
}

export async function dueDocuments(
  tx: Tx,
  limit: number,
  generation: number,
  options: {
    compartments?: string[];
    settledBefore: Timestamp;
    after?: { modifiedAt: Timestamp; evidenceId: EvidenceId };
  },
): Promise<DueDocument[]> {
  const rows = await tx.query<DueDocumentRow>(DUE_DOCUMENTS, [
    options.settledBefore,
    generation,
    options.compartments ?? null,
    options.after?.modifiedAt ?? null,
    options.after?.evidenceId ?? null,
    limit,
  ]);
  return rows.map((row) => {
    const counts = documentTriageFacts(
      open(
        tx.keys,
        { id: row.document_id, compartments: row.compartments, facts_enc: row.document_facts },
        "knowledge.documents.facts_enc",
        "throw",
      ),
    );
    const status =
      row.status_facts === null ? undefined : openStatus(tx, row.compartments, row.evidence_id, row.status_facts);
    const modifiedAt = stamp(row.modified_at);
    return {
      evidenceId: PersonalEvidenceId.parse(row.evidence_id),
      compartment: sourceCompartment(row.compartments),
      modifiedAt,
      ...dueStatus(status),
      triage: {
        reference: row.reference,
        kind: DocumentKind.parse(row.kind),
        mine: row.mine,
        editedByMe: row.edited_by_me,
        ...counts,
        modifiedAt,
      },
    };
  });
}
