import type { Timestamp } from "@intelligence/contracts";
import type { MessageId, TriageLane } from "@intelligence/contracts/personal";
import { stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { newId } from "../../core/ids.ts";
import { REVIEW_LOCK } from "../../core/locks.ts";
import type { Sealed } from "../../core/seal.ts";
import { open, sealUnder } from "../../core/seal.ts";
import type { Tx } from "../../core/tx.ts";
import { claimRecordUnder } from "../admin-owner.ts";
import { statusRows, tryExtractLock } from "./admin-extraction.ts";

// The owner's review of extraction, run as pi_admin: the review sample opens content, for a terminal
// only (`pi extract review`, and `pi extract review-export` as one document); the review state, and
// importing a review and recording its verdicts under the review lock.

// `nothing` is an item with no claim that the owner found nothing missed in: without it such an
// item would leave no row, and be sampled again at every review.
export type Verdict = "right" | "wrong" | "wrong_date" | "missed" | "nothing";

export type ReviewItem = {
  evidenceId: string;
  lane: TriageLane;
  message: { id: MessageId; at: Timestamp; subject: string | null; sender: string | null; text: string | null };
  claims: { id: string; type: string; fields: Record<string, unknown>; span: string }[];
};

export type ReviewVerdict = { evidenceId: string; claimId?: string; type: string; verdict: Verdict };

type MessageRow = {
  id: string;
  evidence_id: string;
  sent_at: Date;
  compartments: string[];
  subject_enc: Sealed;
  sender_enc: Sealed;
  body_enc: Sealed;
};

const columnOpened = (tx: Tx, row: MessageRow, column: "subject_enc" | "sender_enc" | "body_enc"): string | null =>
  row[column] === null ? null : open(tx.keys, row, `knowledge.messages.${column}`, "throw");

// Done items the owner has not reviewed, half with claims and half with none; with `type`, only
// items that hold a claim of it. Each with its message's subject, sender, date and text, and its
// claims' types, fields and spans, opened.
export async function reviewSample(tx: Tx, options: { sample?: number; type?: string } = {}): Promise<ReviewItem[]> {
  const sample = options.sample ?? 50;
  const done = new Map(
    (await statusRows(tx))
      .filter(({ facts }) => facts.status === "done")
      .map(({ row, facts }) => [row.evidence_id, facts.lane]),
  );
  const unreviewed = [...done.keys()];
  const reviewed = await reviewedIds(tx);
  const claimRows = await tx.query<{
    id: string;
    evidence_id: string;
    type: string;
    compartments: string[];
    content_enc: Sealed;
  }>(
    'select id, evidence_id, type, compartments, content_enc from knowledge.claims where evidence_id = any ($1) order by id collate "C"',
    [unreviewed],
  );
  const claimsOf = new Map<string, typeof claimRows>();
  for (const row of claimRows) claimsOf.set(row.evidence_id, [...(claimsOf.get(row.evidence_id) ?? []), row]);
  const candidates = unreviewed.filter((id) => !reviewed.has(id));
  const withClaims = candidates.filter((id) =>
    (claimsOf.get(id) ?? []).some((row) => options.type === undefined || row.type === options.type),
  );
  const without = options.type === undefined ? candidates.filter((id) => !claimsOf.has(id)) : [];
  const shuffled = <T>(list: T[]): T[] =>
    list
      .map((value) => ({ value, key: Math.random() }))
      .sort((a, b) => a.key - b.key)
      .map(({ value }) => value);
  const withPick = shuffled(withClaims);
  const withoutPick = shuffled(without);
  let chosen: string[];
  if (options.type !== undefined) chosen = withPick.slice(0, sample);
  else {
    const first = withPick.slice(0, Math.ceil(sample / 2));
    const none = withoutPick.slice(0, sample - first.length);
    chosen = [...first, ...withPick.slice(first.length, sample - none.length), ...none];
  }

  const items: ReviewItem[] = [];
  for (const evidenceId of chosen) {
    const [message] = await tx.query<MessageRow>(
      "select id, evidence_id, sent_at, compartments, subject_enc, sender_enc, body_enc from knowledge.messages where evidence_id = $1",
      [evidenceId],
    );
    if (message === undefined) continue;
    items.push({
      evidenceId,
      lane: done.get(evidenceId) ?? "skip",
      message: {
        id: message.id as MessageId,
        at: stamp(message.sent_at),
        subject: columnOpened(tx, message, "subject_enc"),
        sender: columnOpened(tx, message, "sender_enc"),
        text: columnOpened(tx, message, "body_enc"),
      },
      claims: (claimsOf.get(evidenceId) ?? []).map((row) => {
        const record = claimRecordUnder(tx.keys, row);
        return {
          id: record.claim.id,
          type: record.claim.content.type,
          fields: record.claim.content.fields,
          span: record.claim.evidence[0]?.span ?? "",
        };
      }),
    });
  }
  return items;
}

const reviewedIds = async (tx: Tx): Promise<Set<string>> =>
  new Set(
    (await tx.query<{ evidence_id: string }>("select distinct evidence_id from vault.extraction_reviews")).map(
      (row) => row.evidence_id,
    ),
  );

// What `pi extract review-import` checks a verdict against: for each id asked about that names an
// item, whether it is done, whether it has a review, and its claims' ids and types, by claim id.
// No content is opened but the claims', for their ids.
async function reviewState(tx: Tx, evidenceIds: string[]): Promise<ReviewState> {
  const asked = new Set(evidenceIds);
  const reviewed = await reviewedIds(tx);
  const state: ReviewState = new Map();
  for (const { row, facts } of await statusRows(tx)) {
    if (asked.has(row.evidence_id))
      state.set(row.evidence_id, {
        done: facts.status === "done",
        reviewed: reviewed.has(row.evidence_id),
        claims: [],
      });
  }
  const claimRows = await tx.query<{ id: string; evidence_id: string; compartments: string[]; content_enc: Sealed }>(
    'select id, evidence_id, compartments, content_enc from knowledge.claims where evidence_id = any ($1) order by id collate "C"',
    [[...state.keys()]],
  );
  for (const row of claimRows) {
    const record = claimRecordUnder(tx.keys, row);
    state.get(row.evidence_id)?.claims.push({ id: record.claim.id, type: record.claim.content.type });
  }
  return state;
}

export type ReviewState = Map<string, { done: boolean; reviewed: boolean; claims: { id: string; type: string }[] }>;

// `pi extract review-import`: the state read, `check` and the writes in one transaction, under the
// review lock and the extract lock, so nothing a check passed changes before its verdicts are
// stored. `check` throws to refuse, and then nothing is written.
export async function importReview(
  tx: Tx,
  evidenceIds: string[],
  check: (state: ReviewState) => ReviewVerdict[],
): Promise<number> {
  await tryExtractLock(tx);
  await tx.query(REVIEW_LOCK);
  const verdicts = check(await reviewState(tx, evidenceIds));
  return verdicts.length === 0 ? 0 : recordReview(tx, verdicts);
}

// Each verdict, sealed with its type and the model that answered the item: the model id of its
// saved call when the verdict is given, so a later retry under another model does not move it.
// An item that has a review already is skipped: a terminal review that sampled it before an
// import stored its verdicts adds nothing.
export async function recordReview(tx: Tx, verdicts: ReviewVerdict[]): Promise<number> {
  await tx.query(REVIEW_LOCK);
  const before = await reviewedIds(tx);
  let written = 0;
  for (const verdict of verdicts) {
    if (before.has(verdict.evidenceId)) continue;
    const [item] = await tx.query<{
      compartments: string[];
      extractor_generation: number | null;
      model_id: string | null;
    }>(
      `select e.compartments, p.extractor_generation,
         (select c.model_id from vault.model_calls c where c.evidence_id = e.id order by c.created_at desc, c.id limit 1) as model_id
       from vault.evidence_items e left join vault.pipeline_items p on p.evidence_id = e.id where e.id = $1`,
      [verdict.evidenceId],
    );
    if (item === undefined) continue;
    const id = newId("rvw");
    await tx.query(
      "insert into vault.extraction_reviews (id, evidence_id, claim_id, extractor_generation, facts_enc, compartments) values ($1, $2, $3, $4, $5, $6)",
      [
        id,
        verdict.evidenceId,
        verdict.claimId === undefined ? null : fingerprint(tx.keys, "claim", verdict.claimId),
        item.extractor_generation ?? 0,
        sealUnder(
          tx.keys,
          item.compartments,
          { table: "vault.extraction_reviews", id, column: "facts_enc" },
          JSON.stringify({ type: verdict.type, verdict: verdict.verdict, modelId: item.model_id }),
        ),
        item.compartments,
      ],
    );
    written += 1;
  }
  return written;
}
