import type { EvidenceId } from "@intelligence/contracts";
import {
  type ClaimRecord,
  CodedError,
  ExtractionCommit,
  type FiledMention,
  MENTION_FIELD,
  type PersonalLogger,
  type PipelineCode,
  RELEASED_LABEL,
  type RestatementCheck,
  type TriageLane,
} from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { vendorRetry } from "@intelligence/personal-core/planner";
import {
  carryKey,
  claimDates,
  earliest,
  firstKnownOf,
  insertClaimValues,
  legacyFactKeyFps,
  valueFpOf,
} from "../core/claim-columns.ts";
import { byText } from "../core/db.ts";
import { claimKey, fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { TITLE_LINK_TYPE } from "../core/link-types.ts";
import { authorWord, BELIEFS_LOCK } from "../core/locks.ts";
import { EXTRACT_AUTHOR, lockRows } from "../core/queue.ts";
import { open, type Sealed, sealUnder } from "../core/seal.ts";
import { lever } from "../core/settings.ts";
import { openStatus, type StatusFacts, statusAt } from "../core/status-facts.ts";
import { setTriggerCause } from "../core/stored-forms.ts";
import type { Tx } from "../core/tx.ts";
import { anchoredProject, bindClaims } from "../identity/project-bindings.ts";
import { fileOrgName } from "../write/named-orgs.ts";
import { removeClaims } from "../write/writer-removal.ts";
import { writeCodeRelations } from "./code-relations.ts";
import { raiseAgentClaims, raiseClientPreference, raiseTitleLinkCard } from "./pipeline-cards.ts";

// What the pipeline writes. Each function is one transaction's work, or one statement. No savepoint and no
// exception block: a commit is whole or not at all.

const MAX_ATTEMPTS = 5;

// The claim types code makes for a capture item at every commit: its project link (`capture.`)
// and its activity facts (`activity.`). No model lane writes either.
const CODE_MADE = /^(capture|activity)\./;

// What a reported change of a belief compares: kind, subject, values, status and the disputed mark.
// A change of support alone (a duplicate, a corroboration, an echo) is none.
export const beliefState = (belief: {
  kind: unknown;
  subject: unknown;
  values: unknown;
  status: unknown;
  disputed: unknown;
}): string =>
  canonicalJson({
    kind: belief.kind,
    subject: belief.subject,
    values: belief.values,
    status: belief.status,
    disputed: belief.disputed,
  });

// A row whose xmin is not the one `open` read in this run has been rewritten since (a re-derive):
// that throws, as any store error does.
export async function lockItem(
  tx: Tx,
  evidenceId: string,
  xmin: string | undefined,
): Promise<{ state: "latest" | "superseded" | "gone"; compartments: string[]; readers: string[]; sourceKind: string }> {
  const [row] = await tx.query<{ compartments: string[]; readers: string[]; source_kind: string; xmin: string }>(
    "select compartments, readers, source_kind, xmin::text as xmin from vault.evidence_items where id = $1 for share",
    [evidenceId],
  );
  if (row === undefined) return { state: "gone", compartments: [], readers: [], sourceKind: "" };
  if (xmin !== undefined && row.xmin !== xmin) throw new CodedError("item_changed");
  const [later] = await tx.query<{ found: boolean }>(
    "select exists (select 1 from vault.evidence_items where supersedes = $1) as found",
    [evidenceId],
  );
  return {
    state: later?.found === true ? "superseded" : "latest",
    compartments: row.compartments,
    readers: row.readers,
    sourceKind: row.source_kind,
  };
}

// The status row's sealed facts as they stand, or none.
// A status row's sealed facts, and beside them the automatic retries it has had (a clear column).
type Stored = { facts: StatusFacts; vendorRetries: number };
async function storedRow(tx: Tx, evidenceId: string): Promise<Stored | undefined> {
  const [row] = await tx.query<{ facts_enc: Sealed; compartments: string[]; vendor_retries: number }>(
    "select facts_enc, compartments, vendor_retries from vault.pipeline_items where evidence_id = $1",
    [evidenceId],
  );
  if (row === undefined) return undefined;
  return { facts: openStatus(tx, row.compartments, evidenceId, row.facts_enc), vendorRetries: row.vendor_retries };
}
const storedStatus = async (tx: Tx, evidenceId: string): Promise<StatusFacts | undefined> =>
  (await storedRow(tx, evidenceId))?.facts;

// The automatic retries a status row is written with: how many it has had, and the minutes until
// the next, or null when none is owed. A commit's are none: it ended the item.
type Retry = { retries: number; afterMinutes: number | null };
const NO_RETRY: Retry = { retries: 0, afterMinutes: null };

// One status row, written whole, under the evidence row's whole label.
async function writeStatus(
  tx: Tx,
  evidenceId: string,
  generation: number,
  facts: StatusFacts,
  marks: { waiting: boolean; withheld: boolean; screened: boolean },
  release: string | null = null,
  retry: Retry = NO_RETRY,
): Promise<void> {
  const [item] = await tx.query<{ compartments: string[] }>(
    "select compartments from vault.evidence_items where id = $1",
    [evidenceId],
  );
  const compartments = item?.compartments ?? [];
  const sealed = sealUnder(tx.keys, compartments, statusAt(evidenceId), JSON.stringify(facts));
  await tx.query(
    `insert into vault.pipeline_items (evidence_id, waiting, withheld, screened, extractor_generation, updated_at, facts_enc, compartments, release_ruling_id, vendor_retries, retry_at)
     values ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9, case when $10::int is null then null else now() + make_interval(mins => $10::int) end)
     on conflict (evidence_id) do update set waiting = excluded.waiting, withheld = excluded.withheld, screened = excluded.screened,
       extractor_generation = excluded.extractor_generation, updated_at = excluded.updated_at, facts_enc = excluded.facts_enc,
       release_ruling_id = excluded.release_ruling_id, vendor_retries = excluded.vendor_retries, retry_at = excluded.retry_at`,
    [
      evidenceId,
      marks.waiting,
      marks.withheld,
      marks.screened,
      generation,
      sealed,
      compartments,
      release,
      retry.retries,
      retry.afterMinutes,
    ],
  );
}

// The owner's lane and the owner's release, as the row holds them: nothing here clears either.
const owners = (stored: StatusFacts | undefined): Pick<StatusFacts, "laneOverride" | "override"> => ({
  ...(stored?.laneOverride === undefined ? {} : { laneOverride: stored.laneOverride }),
  override: stored?.override === true,
});

// The close records of these commitments' fact keys that built no claim, due again: a close that
// found its commitment gone is built again once the commitment is stated again.
const CLOSES_DUE_AGAIN = `
  update vault.pipeline_items p set waiting = true
  where p.evidence_id in (select w.evidence_id from ledger.agent_writes w where w.kind = 'close' and w.close_fact_fp = any ($1::text[]) and w.evidence_id is not null)
    and not p.waiting and not exists (select 1 from knowledge.claims c where c.evidence_id = p.evidence_id)`;

const filedRelation = (mention: FiledMention): boolean =>
  (mention.type === "relationship" &&
    (mention.field === "counterparty" || (mention.field === MENTION_FIELD && mention.firstHand !== true))) ||
  (mention.type === "intro_offer" && mention.field === "person");

type LockedItem = Awaited<ReturnType<typeof lockItem>>;
type Unmapped = ExtractionCommit["unmapped"][number];
// The batch's claims and unmapped claims by their row ids.
type Rows = { claims: Map<string, ClaimRecord>; unmapped: Map<string, Unmapped> };
// The item's claims as they stood, and what of them this commit removes.
type Replaced = { stored: string[]; gone: string[]; kept: number; firstKnown: ReturnType<typeof earliest> };

// An agent record's commit adds, in this order: the beliefs lock when a stored claim is left out, the shared
// taint lock with system:extract's word, its ledger.agent_writes row `for update`, then the item's writes, its
// flag on `quarantine`, and for a `done` commit its restatement marks and its agent_claim cards, but for a
// claim key an echo or a stale reassertion holds back. A flag is final: a flagged record commits `withheld` as
// `quarantine` with no claim, no mark and no card, whatever the batch holds.
export async function commitBatch(
  tx: Tx,
  given: ExtractionCommit,
  xmin: string | undefined,
  log?: PersonalLogger,
): Promise<"committed" | "superseded" | "gone"> {
  const { data, releasedIds, closeIds } = checkedBatch(given);
  // 1. The item's evidence row `for share`, with its xmin, and its source kind.
  const item = await lockItem(tx, data.evidenceId, xmin);
  if (item.state !== "latest") return item.state;
  const agent = item.sourceKind === "agent_record";
  // Only an agent record's claims are checked for restatement, and only an agent record's are released.
  if (!agent && (data.restatements !== undefined || releasedIds.size > 0 || closeIds.size > 0))
    throw new CodedError("invalid_argument");
  // `keep` only on a moment's skipped commit. Unless
  // the owner retried the moment, the claims a model made from it stay: only the claims code makes
  // at every commit (its link and activity claims) become the batch's, and its unmapped claims and
  // filed mentions are left as they are.
  if (data.keep === true && (data.status !== "skipped" || item.sourceKind !== "screen_activity"))
    throw new CodedError("invalid_argument");
  const before = await storedStatus(tx, data.evidenceId);
  const prior = await readPrior(tx, data, before);
  const keeping = data.keep === true && before?.retried !== true;

  // The flag as it stands, read without a lock and read again under it below: a flagged record
  // has no stored claim, so what the batch leaves out is known before any lock.
  const flaggedBefore = agent ? await flagOf(tx, data.evidenceId, false) : false;
  const { restatements: _answers, ...unflagged } = data;
  const batch: ExtractionCommit = flaggedBefore
    ? { ...unflagged, status: "withheld", code: "quarantine", claims: [], unmapped: [], unresolved: 0, mentions: [] }
    : data;

  const rows: Rows = {
    claims: new Map(batch.claims.map((record) => [fingerprint(tx.keys, "claim", record.claim.id), record])),
    unmapped: new Map(batch.unmapped.map((one) => [fingerprint(tx.keys, "claim", one.id), one])),
  };
  const rederived = new Map(Object.entries(prior?.first_known ?? {}));
  const replaced = await readReplaced(tx, batch, rows.claims, keeping, rederived);
  const titled = !agent && batch.claims.some((record) => record.claim.content.type === TITLE_LINK_TYPE);
  await lockAndRemove(tx, batch.evidenceId, {
    gone: replaced.gone,
    agent,
    titled,
    flaggedBefore,
    keepUnmapped: keeping ? undefined : [...rows.unmapped.keys()],
  });
  await insertClaims(tx, batch, item, rows.claims, replaced);
  await afterClaims(tx, batch, item, agent, rows.claims, replaced.stored);
  const present = await fileUnmapped(tx, batch, item, rows.unmapped);
  await fileMentions(tx, batch, item, keeping);
  await writeCommitStatus(tx, batch, before, {
    claims: rows.claims.size + replaced.kept,
    unmapped: keeping ? new Set([...present, ...rows.unmapped.keys()]).size : rows.unmapped.size,
    keeping,
  });
  // The re-derive's carry is spent by a commit that made the item's claims, on the row the status
  // write just locked; a failed, withheld or skipped one leaves it for the next.
  if (rederived.size > 0 && batch.status === "done")
    await tx.query("update vault.pipeline_items set first_known = null where evidence_id = $1", [batch.evidenceId]);
  if (titled) await raiseTitleLinkCard(tx, { claims: rows.claims, compartments: item.compartments, log });
  if (!agent) return "committed";
  await finishAgentRecord(tx, batch, item, rows.claims, flaggedBefore, log);
  return "committed";
}

// The batch, parsed, and the ids of its released claims and of its close and researched claims,
// refused unless every claim is of this item and every restatement answer names one of its claims.
function checkedBatch(given: ExtractionCommit): {
  data: ExtractionCommit;
  releasedIds: Set<string>;
  closeIds: Set<string>;
} {
  const parsed = ExtractionCommit.safeParse(given);
  if (!parsed.success) throw new CodedError("invalid_argument");
  // Every claim is of this item: its id and its evidence are the item's, and every restatement
  // answer names one of its claims.
  if (parsed.data.claims.some((record) => record.claim.primaryEvidenceId !== parsed.data.evidenceId))
    throw new CodedError("invalid_argument");
  // A released claim is of an agent record and labelled `own` alone (the database
  // checks the release behind it), and no restatement answer names one.
  const releasedIds = new Set(
    parsed.data.claims.filter((record) => record.released !== undefined).map((record) => record.claim.id as string),
  );
  // An agent's close claim, which no restatement answer names either. Its label is its
  // commitment's, which the database holds to the owner's standing release. And a fill's researched
  // claim, labelled `own` alone, which no restatement answer names; the database holds it to the
  // fill's standing release.
  const closeIds = new Set(
    parsed.data.claims
      .filter((record) => record.origin === "agent_close" || record.origin === "agent_research")
      .map((record) => record.claim.id as string),
  );
  if (
    parsed.data.claims.some(
      (record) =>
        (record.released !== undefined || record.origin === "agent_research") &&
        JSON.stringify(record.claim.label.compartments) !== JSON.stringify(RELEASED_LABEL),
    )
  )
    throw new CodedError("invalid_argument");
  const claimIds = new Set(parsed.data.claims.map((record) => record.claim.id as string));
  if (
    (parsed.data.restatements ?? []).some(
      (one) => !claimIds.has(one.claimId) || releasedIds.has(one.claimId) || closeIds.has(one.claimId),
    )
  )
    throw new CodedError("invalid_argument");
  return { data: parsed.data, releasedIds, closeIds };
}

// A commit of an item whose stored claims are of a lower generation is a generation raise, so
// its rechecks are backfill and raise nothing (the triggers read pi.trigger_cause); so is the
// first commit after a re-derive, which left the item's status row at generation 0 and no claim.
// A new item with no claim is live, deferred or not. Also read: the re-derive's carry of
// first-known times on the status row.
async function readPrior(
  tx: Tx,
  batch: ExtractionCommit,
  before: StatusFacts | undefined,
): Promise<{ generation: number | null; rederived: boolean; first_known: Record<string, string> | null } | undefined> {
  const [prior] = await tx.query<{
    generation: number | null;
    rederived: boolean;
    first_known: Record<string, string> | null;
  }>(
    `select (select max(c.extractor_generation) from knowledge.claims c where c.evidence_id = $1) as generation,
       exists (select 1 from vault.pipeline_items p where p.evidence_id = $1 and p.extractor_generation = 0) as rederived,
       (select p.first_known from vault.pipeline_items p where p.evidence_id = $1) as first_known`,
    [batch.evidenceId],
  );
  // So is the commit of an item the owner's reroute set waiting.
  if (
    (prior?.generation !== null && prior?.generation !== undefined && prior.generation < batch.generation) ||
    (prior?.generation === null && prior.rederived) ||
    before?.rerouted === true
  ) {
    await setTriggerCause(tx.query, "backfill");
  }
  return prior;
}

// The item's stored claims, those the batch leaves out (only code's when keeping), how many stay
// beside the batch's, and when each value of the claims this commit replaces was first known.
async function readReplaced(
  tx: Tx,
  batch: ExtractionCommit,
  claims: Map<string, ClaimRecord>,
  keeping: boolean,
  rederived: Map<string, string>,
): Promise<Replaced> {
  const storedRows = await tx.query<{ id: string; type: string }>(
    "select id, type from knowledge.claims where evidence_id = $1",
    [batch.evidenceId],
  );
  const stored = storedRows.map((row) => row.id);
  const gone = storedRows
    .filter((row) => !claims.has(row.id) && (!keeping || CODE_MADE.test(row.type)))
    .map((row) => row.id);
  const kept = stored.filter((id) => !claims.has(id) && !gone.includes(id)).length;
  const firstKnown = earliest(await firstKnownOf(tx, gone), rederived);
  return { stored, gone, kept, firstKnown };
}

// The locks, in their order (the beliefs lock, then the shared taint lock and the record's row),
// then the claims left out, and what rests on them, and the unmapped claims the batch does not
// hold (`keepUnmapped` undefined when keeping: they stay).
async function lockAndRemove(
  tx: Tx,
  evidenceId: string,
  {
    gone,
    agent,
    titled,
    flaggedBefore,
    keepUnmapped,
  }: { gone: string[]; agent: boolean; titled: boolean; flaggedBefore: boolean; keepUnmapped: string[] | undefined },
): Promise<void> {
  // 2. The beliefs lock, when a stored claim is left out.
  if (gone.length > 0) await tx.query(BELIEFS_LOCK);
  if (agent || titled) {
    // 3. The shared taint lock and the author's word, before any claim row. 4. The record's row,
    // `for update`, and its flag.
    await lockRows(tx.query, [authorWord(EXTRACT_AUTHOR)]);
    if (agent && (await flagOf(tx, evidenceId, true)) !== flaggedBefore) throw new CodedError("item_changed");
  }
  await removeClaims(tx.query, gone, { asPipeline: true });
  if (keepUnmapped !== undefined)
    await tx.query("delete from vault.unmapped_claims where evidence_id = $1 and not (id = any ($2))", [
      evidenceId,
      keepUnmapped,
    ]);
}

// What is not yet stored. A claim's label is its own, and the database holds it to the evidence's.
// Sealed under the evidence row's whole label; a released claim under its own, `own`, which the
// database holds to the owner's release of the record.
async function insertClaims(
  tx: Tx,
  batch: ExtractionCommit,
  item: LockedItem,
  claims: Map<string, ClaimRecord>,
  { stored, firstKnown }: Replaced,
): Promise<void> {
  for (const [id, record] of claims) {
    if (stored.includes(id)) continue;
    const { claim } = record;
    const released = record.released !== undefined;
    const closes = record.origin === "agent_close";
    const researched = record.origin === "agent_research";
    const factKeyFp = fingerprint(tx.keys, "fact", record.factKey);
    const legacy = legacyFactKeyFps(tx, record);
    const dates = claimDates(record);
    const valueFp = valueFpOf(tx.keys, record);
    await tx.query(
      `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments, legacy_fact_key_fp, legacy_alt_fact_key_fp, released, closes,
         valid_to, due_at, review_at, first_known_at, researched)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, coalesce($17::timestamptz, now()), $18)`,
      [
        id,
        batch.evidenceId,
        claim.content.type,
        claim.validFrom,
        factKeyFp,
        batch.generation,
        claim.label.readers,
        sealUnder(
          tx.keys,
          released || closes || researched ? claim.label.compartments : item.compartments,
          { table: "knowledge.claims", id, column: "content_enc" },
          JSON.stringify(record),
        ),
        claim.label.compartments,
        ...legacy,
        released,
        closes,
        dates.validTo,
        dates.dueAt,
        dates.reviewAt,
        firstKnown.get(carryKey(valueFp, claim.label.compartments)) ?? null,
        researched,
      ],
    );
    await insertClaimValues(tx, {
      id,
      evidenceId: batch.evidenceId,
      factKeyFps: [factKeyFp, ...legacy],
      compartments: claim.label.compartments,
      valueFp,
    });
    await tx.query(
      `insert into knowledge.claim_entities (claim_id, entity_id, compartments)
       select $1, one.entity, $2 from unnest($3::text[]) as one (entity) on conflict do nothing`,
      [id, claim.label.compartments, [...new Set(record.entities)]],
    );
    await fileOrgName(tx, id, record);
  }
}

// What follows from the new claims: code's relations, the closes due again and the project binding.
async function afterClaims(
  tx: Tx,
  batch: ExtractionCommit,
  item: LockedItem,
  agent: boolean,
  claims: Map<string, ClaimRecord>,
  stored: string[],
): Promise<void> {
  // An agent record has no thread; a finding's claims name its project and are read through that, in
  // no belief until the owner confirms one.
  const added = [...claims.keys()].filter((id) => !stored.includes(id));
  // Code's relations for the fact keys the new claims hold, in this transaction: a reversal's
  // `supersedes`, one value from two items' `same_fact`, and the evidence order's `prevails`. A
  // released claim and an agent's close have their own rules and take part in none.
  const related = added.filter((id) => {
    const record = claims.get(id);
    return (
      record !== undefined &&
      record.released === undefined &&
      record.origin !== "agent_close" &&
      record.origin !== "agent_research"
    );
  });
  await writeCodeRelations(tx, related, [
    ...new Set(related.map((id) => fingerprint(tx.keys, "fact", (claims.get(id) as ClaimRecord).factKey))),
  ]);
  // A close that found its commitment gone, now stated again (a new
  // revision of its item), is due again, so it is built against the claim just written.
  const stated = [
    ...new Set(
      [...claims]
        .filter(
          ([id, record]) =>
            !stored.includes(id) && record.origin !== "agent_close" && record.claim.content.type === "commitment",
        )
        .map(([, record]) => fingerprint(tx.keys, "fact", record.factKey)),
    ),
  ];
  if (!agent && stated.length > 0) await tx.query(CLOSES_DUE_AGAIN, [stated]);
  if (!agent && added.length > 0) {
    const [row] = await tx.query<{ thread_fp: string | null }>(
      "select thread_fp from vault.evidence_items where id = $1",
      [batch.evidenceId],
    );
    const anchored = await anchoredProject(tx, row?.thread_fp ?? null, item.compartments);
    if (anchored !== undefined) await bindClaims(tx, added, anchored);
  }
}

// The batch's unmapped claims not yet stored, under the evidence row's whole label; returns the
// ids that were stored before.
async function fileUnmapped(
  tx: Tx,
  batch: ExtractionCommit,
  item: LockedItem,
  unmapped: Map<string, Unmapped>,
): Promise<Set<string>> {
  const present = new Set<string>();
  for (const row of await tx.query<{ id: string; compartments: string[]; facts_enc: Sealed }>(
    "select id, compartments, facts_enc from vault.unmapped_claims where evidence_id = $1",
    [batch.evidenceId],
  )) {
    const given = unmapped.get(row.id);
    // A row stays as it is unless the batch says more of it: a replay gives an older row its detail.
    if (given === undefined || (given.field === undefined && given.issue === undefined)) {
      present.add(row.id);
      continue;
    }
    const stored = JSON.parse(open(tx.keys, row, "vault.unmapped_claims.facts_enc", "throw")) as {
      field?: string;
      issue?: string;
    };
    if (stored.field === given.field && stored.issue === given.issue) present.add(row.id);
    else await tx.query("delete from vault.unmapped_claims where id = $1", [row.id]);
  }
  for (const [id, one] of unmapped) {
    if (present.has(id)) continue;
    await tx.query(
      "insert into vault.unmapped_claims (id, evidence_id, extractor_generation, facts_enc, compartments) values ($1, $2, $3, $4, $5)",
      [
        id,
        batch.evidenceId,
        batch.generation,
        sealUnder(
          tx.keys,
          item.compartments,
          { table: "vault.unmapped_claims", id, column: "facts_enc" },
          JSON.stringify({
            proposedType: one.proposedType,
            reason: one.reason,
            pipelineVersion: String(batch.generation),
            ...(one.field === undefined ? {} : { field: one.field }),
            ...(one.issue === undefined ? {} : { issue: one.issue }),
          }),
        ),
        item.compartments,
      ],
    );
  }
  return present;
}

// Each under the evidence row's whole label, its name sealed and its fingerprint clear.
async function fileMentions(tx: Tx, batch: ExtractionCommit, item: LockedItem, keeping: boolean): Promise<void> {
  if (!keeping) await tx.query("delete from vault.unresolved_mentions where evidence_id = $1", [batch.evidenceId]);
  for (const mention of keeping ? [] : (batch.mentions ?? [])) {
    const id = newId("umn");
    await tx.query(
      "insert into vault.unresolved_mentions (id, evidence_id, extractor_generation, name_fp, facts_enc, compartments, relation, has_speaker, first_hand) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        id,
        batch.evidenceId,
        batch.generation,
        fingerprint(tx.keys, "name", mention.name),
        sealUnder(
          tx.keys,
          item.compartments,
          { table: "vault.unresolved_mentions", id, column: "facts_enc" },
          JSON.stringify(mention),
        ),
        item.compartments,
        filedRelation(mention),
        mention.speakerFp !== undefined,
        mention.firstHand === true,
      ],
    );
  }
}

// The commit's status row, with the release the run read, so the due list can tell.
async function writeCommitStatus(
  tx: Tx,
  batch: ExtractionCommit,
  before: StatusFacts | undefined,
  counts: { claims: number; unmapped: number; keeping: boolean },
): Promise<void> {
  const facts: StatusFacts = {
    lane: batch.lane,
    ...owners(before),
    status: batch.status,
    ...(batch.code === undefined ? {} : { code: batch.code }),
    attempts: 0,
    claims: counts.claims,
    unmapped: counts.unmapped,
    unresolved: counts.keeping ? (before?.unresolved ?? 0) : batch.unresolved,
    ...(batch.groups === undefined ? {} : { groups: batch.groups }),
    ...(batch.leftOut === undefined ? {} : { leftOut: batch.leftOut }),
    ...(batch.repaired === undefined ? {} : { repaired: batch.repaired }),
    ...(batch.reasked === undefined ? {} : { reasked: batch.reasked }),
    ...(batch.ask === undefined ? {} : { ask: batch.ask }),
  };
  await writeStatus(
    tx,
    batch.evidenceId,
    batch.generation,
    facts,
    {
      waiting: false,
      withheld: batch.status === "withheld",
      screened: batch.status === "done" || batch.status === "withheld",
    },
    batch.release ?? null,
  );
  // The re-ask this commit followed, in clear: codes, the wording's id and whether it left a claim,
  // which the stop rule and the report count. A commit that followed none clears it; a defer leaves
  // it, since the item's last answer still stands.
  await tx.query(
    "update vault.pipeline_items set reask_codes = $2, reask_wording = $3, reask_rescued = $4 where evidence_id = $1",
    [batch.evidenceId, batch.reask?.codes ?? null, batch.reask?.wording ?? null, batch.reask?.rescued ?? null],
  );
}

// For one wording of the re-ask, each refusal code's latest re-asks, at most `window`, by the
// item's last commit: how many, and how many left their item a claim. Clear columns only.
export async function reaskRates(
  query: Tx["query"],
  wording: string,
  window: number,
): Promise<{ code: string; asked: number; rescued: number }[]> {
  return query<{ code: string; asked: number; rescued: number }>(
    `select code, count(*)::int as asked, (count(*) filter (where rescued))::int as rescued from (
       select c.code, p.reask_rescued as rescued,
         row_number() over (partition by c.code order by p.updated_at desc, p.evidence_id collate "C") as n
       from vault.pipeline_items p cross join lateral unnest(p.reask_codes) as c (code)
       where p.reask_wording = $1) latest
     where n <= $2 group by code order by code`,
    [wording, window],
  );
}

// An agent record's last steps: its flag, a client-scoped preference's card, and for a `done`
// commit its restatement marks and its cards.
async function finishAgentRecord(
  tx: Tx,
  batch: ExtractionCommit,
  item: LockedItem,
  claims: Map<string, ClaimRecord>,
  flaggedBefore: boolean,
  log: PersonalLogger | undefined,
): Promise<void> {
  // 6. The flag, on the row locked in step 4.
  if (batch.status === "withheld" && batch.code === "quarantine" && !flaggedBefore) {
    await tx.query("update ledger.agent_writes set flagged_at = now() where evidence_id = $1 and flagged_at is null", [
      batch.evidenceId,
    ]);
  }
  if (batch.status === "skipped" && batch.code === "client_scoped") {
    await raiseClientPreference(tx, { evidenceId: batch.evidenceId, compartments: item.compartments, log });
    return;
  }
  if (batch.status !== "done") return;
  // Each claim's claim key, by its row id, in row id order: the marks and the cards both take a
  // key's first claim in that order. A released claim has neither: the owner
  // already answered for it.
  const keys = new Map(
    [...claims]
      .filter(
        ([, record]) =>
          record.released === undefined && record.origin !== "agent_close" && record.origin !== "agent_research",
      )
      .sort(([a], [b]) => byText(a, b))
      .map(([id, record]) => [id, claimKey(tx.keys, batch.evidenceId, fingerprint(tx.keys, "fact", record.factKey))]),
  );
  // After step 5 and before step 7: each claim key's restatement mark, written once.
  const held = await checkRestatements(tx, batch.evidenceId, claims, keys, batch.restatements ?? []);
  // 7. The cards, but for a key an echo or a stale reassertion holds back.
  await raiseAgentClaims(tx, {
    evidenceId: batch.evidenceId,
    compartments: item.compartments,
    claims,
    keys,
    held,
    log,
    ownerQuoted: batch.ownerQuoted === true,
  });
}

// record_echo@1, rung 0's.
const RECORD_ECHO_VERSION = 1;

// The keys whose stored answer is `echo` or `stale` and that the owner has not cleared: their cards are held
// back.
async function checkRestatements(
  tx: Tx,
  evidenceId: string,
  claims: Map<string, ClaimRecord>,
  keys: Map<string, string>,
  answers: RestatementCheck[],
): Promise<Set<string>> {
  const held = new Set<string>();
  if (answers.length === 0) return held;
  const byClaim = new Map(answers.map((one) => [one.claimId, one]));
  const byKey = new Map<string, RestatementCheck>();
  for (const [id, key] of keys) {
    const answer = byClaim.get(claims.get(id)?.claim.id ?? "");
    if (answer !== undefined && !byKey.has(key)) byKey.set(key, answer);
  }
  for (const [key, answer] of [...byKey].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [stored] = await tx.query<{ answer: string; cleared: boolean }>(
      "select answer, cleared from ledger.check_restatement($1, $2, $3, $4, $5, $6)",
      [key, evidenceId, answer.answer, answer.reached, answer.matchedFactKeyFp, RECORD_ECHO_VERSION],
    );
    if ((stored?.answer === "echo" || stored?.answer === "stale") && !stored.cleared) held.add(key);
  }
  return held;
}

// Whether the agent record of this evidence row is flagged; `lock` takes its row `for update`.
// A record with no row was removed under the commit: the evidence row would be gone too. Read
// unflagged first, then flagged: no one index holds both, so each probe has its own
// (agent_writes_key_evidence and agent_writes_flagged_evidence).
async function flagOf(tx: Tx, evidenceId: string, lock: boolean): Promise<boolean> {
  for (const [flagged, term] of [
    [false, "flagged_at is null"],
    [true, "flagged_at is not null"],
  ] as const) {
    const [row] = await tx.query<{ id: string }>(
      `select id from ledger.agent_writes where evidence_id = $1 and ${term} order by id${lock ? " for update" : ""}`,
      [evidenceId],
    );
    if (row !== undefined) return flagged;
  }
  throw new CodedError("item_changed");
}

// The item waits, with this code and lane. Its attempts and the owner's marks stay; no claim
// changes.
// As `commit`, only for its source item's latest stored revision: a status row for a deleted or
// superseded one would outlive the writer's removal of it. No xmin check: a defer follows a
// commit that may have failed on exactly that.
export async function deferItem(
  tx: Tx,
  evidenceId: EvidenceId,
  generation: number,
  outcome: { code: PipelineCode; lane: TriageLane },
): Promise<void> {
  if ((await lockItem(tx, evidenceId, undefined)).state !== "latest") return;
  const stored = await storedRow(tx, evidenceId);
  const before = stored?.facts;
  const facts: StatusFacts = {
    lane: outcome.lane,
    ...owners(before),
    status: "waiting",
    code: outcome.code,
    attempts: before?.attempts ?? 0,
    claims: before?.claims ?? 0,
    unmapped: before?.unmapped ?? 0,
    unresolved: before?.unresolved ?? 0,
    // The owner's retry holds until a commit, through any defer before it, and so does their reroute.
    ...(before?.retried === true ? { retried: true as const } : {}),
    ...(before?.rerouted === true ? { rerouted: true as const } : {}),
    ...(before?.ask === undefined ? {} : { ask: before.ask }),
  };
  // The automatic retries it has had stay counted, so a vendor still away spends them.
  await writeStatus(tx, evidenceId, generation, facts, { waiting: true, withheld: false, screened: false }, null, {
    retries: stored?.vendorRetries ?? 0,
    afterMinutes: null,
  });
}

// One attempt more for each; an item that reaches five is failed with its last code, and no
// longer waiting. One failed by the vendor being away is owed its next automatic retry
// (`requeueRetries` sets it waiting when that comes due) until its tries are spent. An item with
// no row has nothing to count.
export async function countAttempts(tx: Tx, evidenceIds: EvidenceId[], generation: number): Promise<void> {
  for (const evidenceId of evidenceIds) {
    if ((await lockItem(tx, evidenceId, undefined)).state !== "latest") continue;
    const stored = await storedRow(tx, evidenceId);
    if (stored === undefined) continue;
    const { facts: before, vendorRetries } = stored;
    const attempts = before.attempts + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    await writeStatus(
      tx,
      evidenceId,
      generation,
      { ...before, attempts, status: failed ? "failed" : before.status },
      { waiting: !failed, withheld: false, screened: false },
      null,
      failed
        ? vendorRetry(before.code, vendorRetries, {
            max: await lever(tx.query, "extract.vendor_retry_max"),
            baseMinutes: await lever(tx.query, "extract.vendor_retry_base_minutes"),
          })
        : { retries: vendorRetries, afterMinutes: null },
    );
  }
}

// The failed items whose automatic retry has come due, set waiting. Their sealed status stands
// (failed, with its attempts) until the run that takes them writes it: one more attempt with the
// vendor away fails the item again, and that schedules the next retry or spends the last.
export async function requeueRetries(query: Tx["query"]): Promise<{ requeued: number }> {
  const rows = await query(
    "update vault.pipeline_items set waiting = true, retry_at = null where retry_at <= now() and not waiting and not withheld returning evidence_id",
  );
  return { requeued: rows.length };
}
