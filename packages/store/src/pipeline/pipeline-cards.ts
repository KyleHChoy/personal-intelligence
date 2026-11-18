import type { CardId } from "@intelligence/contracts/personal";
// The cards system:extract raises: the owner's needs asked as questions, title links, an agent
// record's cards for its claims (with the settlement, ruling and standing-release checks that
// decide whether one is asked), cards for typed findings' claims, settled claims raised again and
// client preferences. Kept apart from the commit, which calls into it.

import {
  AboutYouKind,
  AgentRecordItem,
  BELIEF_TYPES,
  CARD_CLAIM_TYPES,
  CARD_OPTIONS,
  type ClaimRecord,
  HOLDOUT_SHARE,
  isProjectTyped,
  PERSON_PROPOSAL_TYPES,
  type PersonalEvidenceId,
  type PersonalLogger,
  QUOTED_PROPOSAL_PIPELINE,
  type RulingId,
} from "@intelligence/contracts/personal";
import { legacyFactKeyFps } from "../core/claim-columns.ts";
import { byText } from "../core/db.ts";
import { claimKey, fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import type { Keys } from "../core/keys.ts";
import { TITLE_LINK_TYPE, titleLinkKeyOf } from "../core/link-types.ts";
import { authorWord } from "../core/locks.ts";
import { EXTRACT_AUTHOR, lockRows, raiseCard } from "../core/queue.ts";
import { open, type Sealed } from "../core/seal.ts";
import { CARD_STATE } from "../core/statements.ts";
import type { Tx } from "../core/tx.ts";
import { factAnswer, IN_FORCE, type SettlementRow, settlementOf, writeSettlement } from "./fact-settlements.ts";

// One about_you card for each claim named (the claims' own ids, the latest first),
// through raiseExtractCard: author system:extract, its request id the claim key, as an agent
// record's claim is keyed, so policy.confirmed_claims answers it; its target the claim; its basis
// the claim's message, so a deletion taints it; the claim's compartments; expiring after 30 days.
// A claim that already has a card is passed over; every other is raised, with no daily limit (the
// owner's ruling: a question that gets past the rules that stop one being made is theirs to answer).
// The author's lock is held throughout.
export async function raiseNeedQuestionCards(
  tx: Tx,
  claimIds: readonly string[],
  log: PersonalLogger | undefined,
): Promise<{ raised: number }> {
  const now = await expireAndClock(tx);
  await lockRows(tx.query, [authorWord(EXTRACT_AUTHOR)]);
  const ids = claimIds.map((id) => fingerprint(tx.keys, "claim", id));
  const rows = await tx.query<{ id: string; evidence_id: string; fact_key_fp: string; compartments: string[] }>(
    "select id, evidence_id, fact_key_fp, compartments from knowledge.claims where id = any ($1::text[])",
    [ids],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  let raised = 0;
  for (const id of ids) {
    const row = byId.get(id);
    if (row === undefined) continue;
    const requestId = claimKey(tx.keys, row.evidence_id, row.fact_key_fp);
    const [carded] = await tx.query(
      "select 1 from ledger.cards where created_by = 'system:extract' and request_id = $1",
      [requestId],
    );
    if (carded !== undefined) continue;
    await raiseExtractCard(
      tx,
      {
        kind: "about_you",
        requestId,
        target: { kind: "claim", id },
        compartments: row.compartments,
        cites: [row.evidence_id],
        now,
      },
      log,
    );
    raised += 1;
  }
  return { raised };
}

// A replay raises nothing; a capture.anchor claim raises none.
export async function raiseTitleLinkCard(
  tx: Tx,
  commit: { claims: Map<string, ClaimRecord>; compartments: string[]; log: PersonalLogger | undefined },
): Promise<void> {
  const titled = [...commit.claims]
    .filter(([, record]) => record.claim.content.type === TITLE_LINK_TYPE)
    .sort(([a], [b]) => byText(a, b));
  if (titled.length === 0) return;
  const now = await expireAndClock(tx);
  for (const [id, record] of titled) {
    const requestId = titleLinkKeyOf(tx.keys, fingerprint(tx.keys, "fact", record.factKey));
    await raiseExtractCard(
      tx,
      {
        kind: "agent_claim",
        requestId,
        target: { kind: "claim", id },
        compartments: commit.compartments,
        cites: [],
        now,
      },
      commit.log,
    );
  }
}

const EXPIRY_DAYS = 30;

// The agent record of this evidence row, opened under its whole label.
async function recordItem(tx: Tx, evidenceId: string, compartments: string[]): Promise<AgentRecordItem> {
  const [row] = await tx.query<{ item_enc: Sealed }>("select item_enc from vault.evidence_items where id = $1", [
    evidenceId,
  ]);
  return AgentRecordItem.parse(
    JSON.parse(
      open(
        tx.keys,
        { id: evidenceId, compartments, item_enc: row?.item_enc },
        "vault.evidence_items.item_enc",
        "throw",
      ),
    ),
  );
}

// One card of system:extract's, through raiseCard, as pi_pipeline, expiring after 30 days. A
// card that is not a replay gets its basis from the record's cites through the wrapper; a cite
// with no row leaves the card raised and logs card_basis_partial with its id.
async function raiseExtractCard(
  tx: Tx,
  card: {
    kind: "agent_claim" | "about_you" | "client_preference";
    requestId: string;
    target: { kind: string; id: string };
    compartments: string[];
    cites: string[];
    now: Date;
    matchFp?: string;
    caseKey?: string;
  },
  log: PersonalLogger | undefined,
): Promise<string> {
  const raised = await raiseCard(
    tx.query,
    {
      id: newId("crd") as CardId,
      requestId: card.requestId,
      kind: card.kind,
      author: EXTRACT_AUTHOR,
      options: [...CARD_OPTIONS[card.kind]],
      target: card.target,
      refs: [],
      compartments: [...card.compartments].sort(byText),
      expiresAt: null,
      expiresAfterDays: EXPIRY_DAYS,
      caseKey: card.caseKey ?? null,
      run: null,
      body: null,
      bodyFrom: null,
    },
    { now: card.now, ...(log === undefined ? {} : { log }) },
  );
  if (raised.replayed) return raised.id;
  // The card's match key, set once, in its raise's transaction.
  if (card.matchFp !== undefined)
    await tx.query("update ledger.cards set match_fp = $2 where id = $1 and match_fp is null", [
      raised.id,
      card.matchFp,
    ]);
  const [basis] = await tx.query<{ ok: boolean }>("select ledger.add_agent_claim_basis($1, $2) as ok", [
    raised.id,
    card.cites,
  ]);
  if (basis?.ok !== true) log?.warn({ event: "card_basis_partial", ids: { card: raised.id } });
  return raised.id;
}

// The database's clock, read once, for the cards and, inside the function, the lane's expiry.
async function expireAndClock(tx: Tx): Promise<Date> {
  const [clock] = await tx.query<{ now: Date }>("select now() as now");
  await tx.query("select ledger.expire_agent_claims()");
  return clock?.now ?? new Date();
}

// Step 7 of an agent record's commit: the lane's own expiry, then one card for each claim key among the
// batch's claims of a belief type: agent_claim for a finding's, about_you for a proposal's, each with the
// claim key as its request id; none for an answer's.
export async function raiseAgentClaims(
  tx: Tx,
  commit: {
    evidenceId: string;
    compartments: string[];
    claims: Map<string, ClaimRecord>;
    keys: Map<string, string>;
    held: Set<string>;
    log: PersonalLogger | undefined;
    ownerQuoted?: boolean;
  },
): Promise<void> {
  const byKey = new Map<string, string>();
  for (const [id, key] of commit.keys) {
    // And the types of a propose_person body, which build no belief but wait for
    // the owner's confirm on an about_you card all the same.
    const type = commit.claims.get(id)?.claim.content.type ?? "";
    if (!(BELIEF_TYPES as readonly string[]).includes(type) && !PERSON_PROPOSAL_TYPES.includes(type)) continue;
    // An agent's fact about a project asks the owner nothing: it reads as agent-reported and
    // unconfirmed, and the owner removes it with its record.
    if (commit.claims.get(id)?.subjectKind === "project") continue;
    if (!byKey.has(key) && !commit.held.has(key)) byKey.set(key, id);
  }
  const now = await expireAndClock(tx);
  if (byKey.size === 0) return;
  const item = await recordItem(tx, commit.evidenceId, commit.compartments);
  // An answer record is the owner's own statement, kept by policy.answered_records; it
  // raises no card.
  if (item.kind === "answer") return;
  const kind = item.kind === "proposal" ? "about_you" : "agent_claim";
  for (const [key, claim] of [...byKey].sort(([a], [b]) => byText(a, b))) {
    // One card per fact: a claim whose match key the owner already answered, or whose
    // fact has a card open, raises none; a settlement records it. A claim already carded replays,
    // one already settled stays so, and one the owner reopened is raised without asking again.
    const record = commit.claims.get(claim);
    const given = record?.matchKey;
    const matchFp = given === undefined ? undefined : fingerprint(tx.keys, "fact", given);
    // A claim already carded replays its card, whatever came since.
    let held = false;
    if (!(await carded(tx, key))) {
      if (matchFp !== undefined) {
        const settled = await settlementOf(tx.query, key);
        if (settled !== undefined && settled.reopened_at === null) continue;
        const answer = settled === undefined ? await factAnswer(tx.query, matchFp, commit.compartments) : undefined;
        if (answer !== undefined) {
          await writeSettlement(tx.query, {
            claim_key: key,
            card_id: answer.card,
            answer: answer.answer,
            kind,
            claim_id: claim,
            evidence_id: commit.evidenceId,
            match_fp: matchFp,
            withdrawn_card_id: null,
            written_by: "pipeline",
            compartments: commit.compartments,
          });
          continue;
        }
      }
      // After the settlement, which records an answer the owner already gave, no card for a fact past
      // its end, nor for one they vetoed (Never use, in force on its fact key or its match key within
      // the card's label). A fact the owner marked not true is asked, never kept under a grant: a reject
      // is of one item's statement, and a later state of a value-keyed kind shares its key. A
      // retired fact stated again is asked again.
      const ruled = record === undefined ? null : await rulingOn(tx, record, matchFp, commit.compartments);
      if (record !== undefined && (ended(record, now) || ruled === "veto")) {
        commit.log?.info({
          event: "card_not_raised",
          ids: { evidence: commit.evidenceId as PersonalEvidenceId },
          code: ended(record, now) ? "ended" : "vetoed",
        });
        continue;
      }
      // A proposal that quotes the owner, of a kind their standing release
      // covers for this agent, is released under it in place of a card (policy.grant_release
      // refuses anything else, and the owner's veto outranks it). The next run builds its released claim,
      // at the granted-release tier.
      // And only when the pipeline found its quote in an item the owner sent, and the record is not
      // one held out to keep the agent's confirm rate measured: its card is marked by its case key.
      const quoted =
        kind === "about_you" &&
        record !== undefined &&
        ruled === null &&
        commit.ownerQuoted === true &&
        grantable(record);
      held = quoted && heldOut(tx.keys, item.recordId);
      if (quoted && !held && record !== undefined) {
        const [granted] = await tx.query<{ ruling: string | null }>("select policy.grant_release($1, $2) as ruling", [
          commit.evidenceId,
          record.claim.content.type,
        ]);
        if (granted?.ruling != null) {
          commit.log?.info({
            event: "standing_release",
            ids: { evidence: commit.evidenceId as PersonalEvidenceId, ruling: granted.ruling as RulingId },
          });
          continue;
        }
      }
    }
    await raiseExtractCard(
      tx,
      {
        kind,
        requestId: key,
        target: { kind: "claim", id: claim },
        compartments: commit.compartments,
        cites: item.cites,
        now,
        ...(matchFp === undefined ? {} : { matchFp }),
        ...(held ? { caseKey: `${HELD_CASE}${key.slice(0, 64 - HELD_CASE.length)}` } : {}),
      },
      commit.log,
    );
  }
}

// While a standing release is on, HOLDOUT_SHARE of the quoted proposals it covers are asked by card
// all the same, so the owner's answers keep its agent's confirm rate measured. Chosen from the record's
// id under the store's fingerprint key, so one record is always held out or never and no agent can
// tell which. A held-out card's case key is HELD_CASE and its claim key's start, unique to it, so
// the confirm rates count its answer apart (policy.confirm_rates).
const HELD_CASE = "held:";
export const heldOut = (keys: Keys, recordId: string): boolean =>
  Number.parseInt(fingerprint(keys, "holdout", recordId).slice(0, 8), 16) / 2 ** 32 < HOLDOUT_SHARE;

// A claim whose end (`until`, the end of that day) has passed asks nothing.
const ended = (record: ClaimRecord, now: Date): boolean =>
  record.claim.validTo !== undefined && Date.parse(record.claim.validTo) < now.getTime();

// The owner's strongest ruling in force on the claim's fact key, its version 1 keys or its match key,
// among their rulings within the card's label (policy.fact_ruled): `veto`, `reject` or null.
async function rulingOn(
  tx: Tx,
  record: ClaimRecord,
  matchFp: string | undefined,
  compartments: readonly string[],
): Promise<"veto" | "reject" | null> {
  const [legacy, alt] = legacyFactKeyFps(tx, record);
  const fps = [fingerprint(tx.keys, "fact", record.factKey), legacy, alt, matchFp ?? null].filter(
    (fp): fp is string => fp !== null,
  );
  const [row] = await tx.query<{ ruled: "veto" | "reject" | null }>("select policy.fact_ruled($1, $2) as ruled", [
    fps,
    [...compartments],
  ]);
  return row?.ruled ?? null;
}

// Only a proposal that quotes the owner's words (its pipeline version, which the
// store's quote check sets) of an about-you kind may be kept under a standing release; a
// paraphrase is always asked.
const grantable = (record: ClaimRecord): boolean =>
  record.origin === "agent_record" &&
  record.released === undefined &&
  record.claim.pipelineVersion === QUOTED_PROPOSAL_PIPELINE &&
  AboutYouKind.safeParse(record.claim.content.type).success;

// A typed finding's claims are written by policy.write_typed_claims at the agent's call, never
// committed by this pipeline, so their agent_claim cards are raised here, as pi_pipeline, by the
// agent lane's own step 7 (raiseAgentClaims: one card per fact and its settlement). A typed record
// whose claims of a carded type have a claim key with neither a card nor a settlement is due; at
// most TYPED_CARD_ITEMS a run, oldest record first, by the partial index evidence_items_typed. A
// claim key is its record and fact key (claimKey), so claims of one record and one fact key share
// it and are carded once, as raiseAgentClaims keys them. A record under a compartment this pipeline
// holds no key for is passed over, as the agent lane's DUE passes it over. An agent's word on a
// project is read at its own tier, below the owner's and a source's, and the owner is asked
// nothing.
const TYPED_CARD_TYPES: readonly string[] = CARD_CLAIM_TYPES.filter((type) => !isProjectTyped(type));
const TYPED_CARD_ITEMS = 200;
const TYPED_UNCARDED = `
  select e.id, e.compartments from vault.evidence_items e
  where e.typed and e.compartments <@ $3::text[] and exists (
    select 1 from knowledge.claims c
    where c.evidence_id = e.id and c.type = any ($1::text[])
      and not exists (
        select 1 from knowledge.claims o join ledger.cards k on k.target_kind = 'claim' and k.target_id = o.id and k.created_by = 'system:extract'
        where o.evidence_id = c.evidence_id and o.fact_key_fp = c.fact_key_fp)
      and not exists (
        select 1 from knowledge.claims o join ledger.fact_settlements s on s.claim_id = o.id
        where o.evidence_id = c.evidence_id and o.fact_key_fp = c.fact_key_fp))
  order by e.observed_at, e.id collate "C"
  limit $2`;
export async function raiseTypedClaimCards(tx: Tx, log: PersonalLogger | undefined): Promise<{ raised: number }> {
  await lockRows(tx.query, [authorWord(EXTRACT_AUTHOR)]);
  const items = await tx.query<{ id: string; compartments: string[] }>(TYPED_UNCARDED, [
    [...TYPED_CARD_TYPES],
    TYPED_CARD_ITEMS,
    [...tx.keys.compartments.keys()],
  ]);
  for (const item of items) {
    const rows = await tx.query<{ id: string; fact_key_fp: string; content_enc: Sealed }>(
      'select id, fact_key_fp, content_enc from knowledge.claims where evidence_id = $1 and type = any ($2::text[]) order by id collate "C"',
      [item.id, [...TYPED_CARD_TYPES]],
    );
    const claims = new Map(
      rows.map((row) => [
        row.id,
        JSON.parse(
          open(
            tx.keys,
            { id: row.id, compartments: item.compartments, content_enc: row.content_enc },
            "knowledge.claims.content_enc",
            "throw",
          ),
        ) as ClaimRecord,
      ]),
    );
    const keys = new Map(rows.map((row) => [row.id, claimKey(tx.keys, item.id, row.fact_key_fp)]));
    await raiseAgentClaims(tx, {
      evidenceId: item.id,
      compartments: item.compartments,
      claims,
      keys,
      held: new Set(),
      log,
    });
  }
  return { raised: items.length };
}

// Whether system:extract already raised a card under this request id.
async function carded(tx: Tx, requestId: string): Promise<boolean> {
  return (
    (await tx.query("select 1 from ledger.cards where created_by = 'system:extract' and request_id = $1", [requestId]))
      .length > 0
  );
}

// Once each run: the card of every settlement the owner reopened,
// raised without asking policy.fact_answer, keeping its match key; and, for each card that ended
// without an answer from the owner (expired, withdrawn but by their answer, tainted, or answered by anything but
// `decide`), one card for the first claim waiting on it, the others then waiting on that one. A
// claim whose record or claim is gone is passed over. The author's lock is held throughout.
// The pipeline reads only its own rows, so a claim `decide` settled still reads `waiting` to it: a
// card the owner decided or whose withdrawal their answer made never counts as ended, and such rows are left
// out in the one statement. No card is raised twice: a claim key already carded
// is passed over.
const DUE = `
  select s.* from ledger.fact_settlements s join ledger.cards c on c.id = s.card_id
  where s.claim_id is not null and ${IN_FORCE}
    and not exists (select 1 from ledger.cards k where k.created_by = 'system:extract' and k.request_id = s.claim_key)
    and (s.reopened_at is not null
         or (s.answer = 'waiting'
             and (c.tainted_at is not null or ${CARD_STATE} not in ('pending', 'deferred'))
             and not exists (select 1 from ledger.record_events e where e.row_kind = 'card' and e.row_id = c.id and e.by = 'owner' and e.event in ('decided', 'withdrawn'))))
  order by s.created_at, s.id`;
// The cards of reopened settlements and of claims released by a card that ended without the
// owner's reply; and the agent_claim cards of typed findings' claims, which no commit of the
// pipeline raises, in the same transaction.
export async function raiseReleasedCards(tx: Tx, log: PersonalLogger | undefined): Promise<{ raised: number }> {
  const settled = await raiseSettledClaims(tx, log);
  const typed = await raiseTypedClaimCards(tx, log);
  return { raised: settled.raised + typed.raised };
}

export async function raiseSettledClaims(tx: Tx, log: PersonalLogger | undefined): Promise<{ raised: number }> {
  const now = await expireAndClock(tx);
  await lockRows(tx.query, [authorWord(EXTRACT_AUTHOR)]);
  const rows = await tx.query<SettlementRow>(DUE);
  const replaced = new Map<string, string>();
  let raised = 0;
  for (const row of rows) {
    const reopened = row.reopened_at !== null;
    const card = reopened ? undefined : replaced.get(row.card_id);
    if (card !== undefined) {
      // The others wait on the card raised for the first.
      await writeSettlement(tx.query, { ...row, card_id: card, withdrawn_card_id: null, written_by: "pipeline" });
      continue;
    }
    if (row.evidence_id === null) continue;
    const [item] = await tx.query<{ compartments: string[] }>(
      "select compartments from vault.evidence_items where id = $1",
      [row.evidence_id],
    );
    // The claim by its claim key, not its stored id: a generation raise remakes every claim id and
    // keeps the claim key.
    const claims = await tx.query<{ id: string; fact_key_fp: string }>(
      'select id, fact_key_fp from knowledge.claims where evidence_id = $1 order by id collate "C"',
      [row.evidence_id],
    );
    const claim = claims.find((one) => claimKey(tx.keys, row.evidence_id as string, one.fact_key_fp) === row.claim_key);
    if (item === undefined || claim === undefined) continue;
    const record = await recordItem(tx, row.evidence_id, item.compartments);
    const id = await raiseExtractCard(
      tx,
      {
        kind: row.kind,
        requestId: row.claim_key,
        target: { kind: "claim", id: claim.id },
        compartments: row.compartments,
        cites: record.cites,
        now,
        matchFp: row.match_fp,
      },
      log,
    );
    raised += 1;
    if (!reopened) replaced.set(row.card_id, id);
  }
  return { raised };
}

// Only a proposal's commit raises one.
export async function raiseClientPreference(
  tx: Tx,
  commit: { evidenceId: string; compartments: string[]; log: PersonalLogger | undefined },
): Promise<void> {
  const now = await expireAndClock(tx);
  const item = await recordItem(tx, commit.evidenceId, commit.compartments);
  if (item.kind !== "proposal") return;
  await raiseExtractCard(
    tx,
    {
      kind: "client_preference",
      requestId: item.recordId,
      target: { kind: "agent_record", id: item.recordId },
      compartments: commit.compartments,
      cites: item.cites,
      now,
    },
    commit.log,
  );
}
