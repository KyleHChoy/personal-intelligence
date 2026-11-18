import { BeliefStatus } from "@intelligence/contracts";
import {
  ACTIVITY_FACT_TYPES,
  BELIEF_TYPES,
  type BeliefRulingView,
  type CardLine,
  type ClaimRecord,
  type DocumentId,
  type EntityId,
  FactDetail,
  FactId,
  type FactKeyFp,
  type FactSource,
  FactView,
  KEY_FIELDS,
  LIFE_DOMAINS,
  type LineSource,
  PERSON_PROPOSAL_TYPES,
  type PersonalCompartment,
  type RulingId,
  type Who,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError, asRulingError } from "../../core/admin-error.ts";
import { ownerAudience } from "../../core/audience.ts";
import { type Query, stamp, stampOrNull } from "../../core/db.ts";
import { claimKey } from "../../core/fingerprint.ts";
import { requestIdOf } from "../../core/ids.ts";
import { LINK_TYPES, TITLE_LINK_TYPE, titleLinkKeyOf } from "../../core/link-types.ts";
import { BELIEFS_LOCK } from "../../core/locks.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { revokeRuled } from "../../core/promotion-revoke.ts";
import { lockRows } from "../../core/queue.ts";
import type { Sealed } from "../../core/seal.ts";
import { sealUnder } from "../../core/seal.ts";
import { OWNER_ENTITY, PROJECT_NAMES } from "../../core/statements.ts";
import { openedUnder } from "../../core/tx.ts";
import { answeredEvidence, confirmedKeys } from "../../pipeline/pipeline-read.ts";
import { ADMIN_FACT_SOURCE } from "../../read/fact-source.ts";
import { untrusted, type Sealed as ValueRow } from "../../read/read-ctx.ts";
import { passageOf, servedField, VALID_TO_TYPES } from "../../read/read-fact-rows.ts";
import { whoOf } from "../../read/read-who.ts";
import { claimRecordUnder, ownerBeliefs } from "../admin-owner.ts";
import { notTrueTeaches, proposeAfterAnswer } from "../cards/admin-confirm-rates.ts";
import { editRequestId, reopenAnswered } from "../cards/admin-reopen.ts";
import { ownerCtx } from "../owner-ctx.ts";
import { correctionOf, OWNER_NOTE_TYPE } from "../people/owner-note.ts";
import { liftConfirmation } from "./admin-release.ts";
import { liftRulings } from "./owner-ruling.ts";
import { anchorRuling } from "./ruling-anchors.ts";

// The owner's corrections and fact vetoes: a claim that counts in no belief, and a fact key whose belief is
// closed, each in one transaction, and `pi facts show`, the owner's view of one claim before they rule on it.
// Nothing here builds a belief: a ruling deletes the beliefs of its fact key that its audiences see, and the
// next `pi extract` rebuilds them under it.

export type Verdict = BeliefRulingView["verdict"];

// What each verdict writes as a decision, and as the decision that lifts it. A `retire` holds by its fact key as a `veto` does, until a claim
// dated after it. A `domain` or a `kind` holds by its fact key, its value sealed beside it.
const KIND = {
  reject: "correction",
  veto: "fact_veto",
  retire: "fact_retire",
  domain: "fact_domain",
  kind: "fact_kind",
} as const;
const LIFT = {
  reject: "correction_lift",
  veto: "fact_veto_lift",
  retire: "fact_retire_lift",
  domain: "fact_domain_lift",
  kind: "fact_kind_lift",
} as const;

// A domain from the closed list for an owner-side kind; a kind among the owner-side kinds, from
// another of them, but a preference, whose polarity no ruling gives.
const ownerSide = (type: string): boolean => Object.hasOwn(KEY_FIELDS, type);
function rulable(verdict: "domain" | "kind", type: string, value: string): boolean {
  if (!ownerSide(type)) return false;
  return verdict === "domain"
    ? (LIFE_DOMAINS as readonly string[]).includes(value)
    : ownerSide(value) && value !== type && value !== "preference";
}

const viaOf = (tag?: { via: "cleanup" }): { via?: "cleanup" } => (tag === undefined ? {} : { via: tag.via });

// The source items of the claims of a fact key that a belief of it counts, read from the claims and not
// from a projection (invariant 3).
const KEY_CLAIMS = `
  select c.id, c.evidence_id, c.fact_key_fp, c.compartments, c.content_enc, e.source_account_id, e.source_item_fp,
    array_remove(array_remove(array[c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp], null), c.fact_key_fp) as legacy
  from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
  where c.fact_key_fp = $1
    and not exists (
      select 1 from policy.rejected_claims() r
      where r.source_account_id = e.source_account_id and r.source_item_fp = e.source_item_fp
        and r.fact_key_fp in (c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp))
  order by e.source_account_id collate "C", e.source_item_fp collate "C", c.id collate "C"`;

type Item = { source_account_id: string; source_item_fp: string };

export async function ruledItems(admin: AdminContext, query: Query, factKeyFp: string): Promise<Item[]> {
  const rows = await query<
    Item & {
      id: string;
      evidence_id: string;
      fact_key_fp: string;
      compartments: string[];
      content_enc: Sealed;
      legacy: string[];
    }
  >(KEY_CLAIMS, [factKeyFp]);
  const claims = rows.map((row) => ({
    row,
    record: claimRecordUnder(admin.keys, row),
  }));
  const tx = { query, keys: admin.keys };
  const keysOf = (row: (typeof rows)[number]): string[] =>
    [row.fact_key_fp, ...row.legacy].map((fp) => claimKey(tx.keys, row.evidence_id, fp));
  const agent = claims.filter((one) => one.record.origin === "agent_record");
  const titled = claims.filter((one) => one.record.claim.content.type === TITLE_LINK_TYPE);
  const confirmed = await confirmedKeys(query, [
    ...agent.flatMap((one) => keysOf(one.row)),
    ...titled.map((one) => titleLinkKeyOf(admin.keys, one.row.fact_key_fp)),
  ]);
  const answered = await answeredEvidence(
    query,
    agent.map((one) => one.row.evidence_id),
  );
  const counted = claims.filter(
    ({ row, record }) =>
      (record.origin !== "agent_record" ||
        record.released !== undefined ||
        answered.has(row.evidence_id) ||
        keysOf(row).some((key) => confirmed.has(key))) &&
      (record.claim.content.type !== TITLE_LINK_TYPE || confirmed.has(titleLinkKeyOf(admin.keys, row.fact_key_fp))),
  );
  const items = new Map(
    counted.map(({ row }) => [
      `${row.source_account_id}\n${row.source_item_fp}`,
      { source_account_id: row.source_account_id, source_item_fp: row.source_item_fp },
    ]),
  );
  return [...items.values()];
}

// The claim a command names, with the item it was taken from. Its compartments for a `reject`; for a `veto` or a
// `retire`, those of every claim of its fact key. `latest` is the latest time of a claim of its fact key, which
// a `retire` in force is compared with.
export type Named = {
  type: string;
  fact_key_fp: string;
  source_account_id: string;
  source_item_fp: string;
  compartments: PersonalCompartment[];
  latest: Date;
};

export async function named(query: Query, id: FactId, verdict: Verdict): Promise<Named | undefined> {
  const [row] = await query<Named>(
    `select c.type, c.fact_key_fp, e.source_account_id, e.source_item_fp,
       case when $2::text = 'reject' then ledger.label(c.compartments)
         else ledger.label(array(select x from knowledge.claims k cross join unnest(k.compartments) as x where k.fact_key_fp = c.fact_key_fp)) end as compartments,
       (select max(k.valid_from) from knowledge.claims k where k.fact_key_fp = c.fact_key_fp) as latest
     from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
     where c.id = $1`,
    [id, verdict],
  );
  return row;
}

// A `retire` in force is one no claim of its fact key is dated after; a fact stated again since its retire may
// be retired again. One domain and one kind in force per fact key; a second replaces it.
export type Standing = { ruling_id: RulingId; compartments: PersonalCompartment[]; value_enc: Sealed };
export async function standing(query: Query, verdict: Verdict, claim: Named): Promise<Standing | undefined> {
  const [row] = await query<Standing>(
    `select ruling_id, compartments, value_enc from knowledge.belief_rulings where verdict = $1::text and lifted_at is null and fact_key_fp = $2
       and ($1::text in ('veto', 'domain', 'kind') or ($1::text = 'retire' and created_at >= $5) or ($1::text = 'reject' and source_account_id = $3 and source_item_fp = $4))`,
    [verdict, claim.fact_key_fp, claim.source_account_id, claim.source_item_fp, claim.latest],
  );
  return row;
}

async function rule(
  admin: AdminContext,
  id: FactId,
  verdict: Verdict,
  requestId: string,
  value?: string,
): Promise<RulingId> {
  try {
    return await admin.transaction((query) => ruleIn(admin, query, id, verdict, requestId, value));
  } catch (error) {
    throw asRulingError(error);
  }
}

// One ruling in the caller's transaction (`pi commitments close` writes its own decision beside it). `tag`: the
// cleanup's, its `via` in the decision's details and, for a lapse, the time the ruling holds from.
export async function ruleIn(
  admin: AdminContext,
  query: Query,
  id: FactId,
  verdict: Verdict,
  requestId: string,
  value?: string,
  tag?: { via: "cleanup"; at?: Date },
): Promise<RulingId> {
  const now = admin.now();
  await query(BELIEFS_LOCK);
  await lockRows(query, []);
  // One that made another kind of decision is refused.
  const [repeat] = await query<{ id: RulingId; kind: string }>(
    "select id, kind from knowledge.owner_decisions where request_id = $1",
    [requestId],
  );
  if (repeat !== undefined) {
    if (repeat.kind !== KIND[verdict]) throw new AdminError("invalid_argument");
    return repeat.id;
  }
  const claim = FactId.safeParse(id).success ? await named(query, id, verdict) : undefined;
  if (claim === undefined) throw new AdminError("not_found");
  // A domain or a kind the fact's type may not take.
  const reclassify = verdict === "domain" || verdict === "kind";
  // The owner vetoes, retires or rejects a person, a tie or a link an agent proposed (invariant 11),
  // though none builds a belief; a domain or a kind it has none. And the owner retires a note of
  // their own, which builds none either.
  const note = verdict === "retire" && claim.type === OWNER_NOTE_TYPE;
  if (
    !note &&
    !(BELIEF_TYPES as readonly string[]).includes(claim.type) &&
    (reclassify || !PERSON_PROPOSAL_TYPES.includes(claim.type))
  )
    throw new AdminError("no_belief");
  if (reclassify && (value === undefined || !rulable(verdict, claim.type, value)))
    throw new AdminError("invalid_argument");
  // R-W1: a second domain or kind replaces the one in force, in this one decision, which supersedes
  // and lifts it; one of the same value is the ruling in force, and writes nothing. Any other
  // verdict in force is `already_ruled`.
  const replaced = await standing(query, verdict, claim);
  if (replaced !== undefined && !reclassify) throw new AdminError("already_ruled");
  if (
    replaced !== undefined &&
    openedUnder(
      admin.keys,
      replaced.compartments,
      { table: "knowledge.belief_rulings", id: replaced.ruling_id, column: "value_enc" },
      replaced.value_enc,
    ) === value
  ) {
    return replaced.ruling_id;
  }

  const ruling = await ownerDecision(
    query,
    {
      requestId,
      kind: KIND[verdict],
      supersedes: replaced?.ruling_id ?? null,
      details: verdict === "reject" ? { claim: id } : { factKey: claim.fact_key_fp as FactKeyFp, ...viaOf(tag) },
      compartments: claim.compartments,
    },
    now,
  );
  if (replaced !== undefined) {
    // Lifted before the insert below.
    await liftRulings(query, "knowledge.belief_rulings", [replaced.ruling_id], ruling, now);
  }
  // A `domain` or a `kind` by its fact key, its value sealed under the ruling's label.
  const reject = verdict === "reject";
  // A veto or a retire records the items of the claims a belief of its key counts, the evidence
  // behind the ruled belief, so that after the go it reaches by their version 1 key only what those
  // items say: not a rejected claim's or an unconfirmed record's.
  const items =
    verdict === "veto" || verdict === "retire" ? await ruledItems(admin, query, claim.fact_key_fp) : undefined;
  await query(
    `insert into knowledge.belief_rulings (ruling_id, verdict, claim_fp, source_account_id, source_item_fp, fact_key_fp, created_at, compartments, value_enc, item_account_ids, item_fps)
     values ($1, $2, $3, $4, $5, $6, $7, ledger.label($8), $9, $10, $11)`,
    [
      ruling,
      verdict,
      id,
      reject ? claim.source_account_id : null,
      reject ? claim.source_item_fp : null,
      claim.fact_key_fp,
      stamp(tag?.at ?? now),
      claim.compartments,
      reclassify
        ? sealUnder(
            admin.keys,
            claim.compartments,
            { table: "knowledge.belief_rulings", id: ruling, column: "value_enc" },
            value as string,
          )
        : null,
      items?.map((one) => one.source_account_id) ?? null,
      items?.map((one) => one.source_item_fp) ?? null,
    ],
  );
  // A veto or a retire outranks a promotion the owner approved: each in force that carries a claim
  // of the key is revoked here, in the ruling's transaction.
  if (verdict === "veto" || verdict === "retire") await revokeRuled(query, claim.fact_key_fp, now);
  // What the ruling was made on, beside its key.
  await anchorRuling(admin, query, ruling);
  return ruling;
}

// Not true on a fact kept under a standing release counts against its grant: then the confirm rates'
// pass, never on a replay. `learn: false` leaves it to one `learnAfterNotTrue` for a batch.
export async function rejectClaim(
  admin: AdminContext,
  id: FactId,
  options: { requestId: string; learn?: boolean },
): Promise<RulingId> {
  const teaches = options.learn !== false && (await notTrueTeaches(admin, [id], options.requestId));
  const ruling = await rule(admin, id, "reject", options.requestId);
  if (teaches) await proposeAfterAnswer(admin);
  return ruling;
}

export function vetoFact(admin: AdminContext, id: FactId, options: { requestId: string }): Promise<RulingId> {
  return rule(admin, id, "veto", options.requestId);
}

export function reclassifyFact(
  admin: AdminContext,
  id: FactId,
  verdict: "domain" | "kind",
  value: string,
  options: { requestId: string },
): Promise<RulingId> {
  return rule(admin, id, verdict, options.requestId, value);
}

// `pi self retire`, the fact true and past until it is stated again.
export function retireFact(admin: AdminContext, id: FactId, options: { requestId: string }): Promise<RulingId> {
  return rule(admin, id, "retire", options.requestId);
}

export async function listRulings(admin: AdminContext): Promise<BeliefRulingView[]> {
  return admin.transaction(async (query) => {
    // A ruling that names no claim by its fact key but reaches one by its version 1 key is
    // `carried`, not gone: a reject by its item, a veto or a retire by an item it recorded. A
    // domain or a kind is not carried.
    const rows = await query<{
      ruling_id: RulingId;
      verdict: Verdict;
      claim_fp: FactId;
      fact_key_fp: FactKeyFp;
      created_at: Date;
      lifted_at: Date | null;
      direct: boolean;
      carried: boolean;
    }>(
      `select r.ruling_id, r.verdict, r.claim_fp, r.fact_key_fp, r.created_at, r.lifted_at,
         exists (
           select 1 from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
           where c.fact_key_fp = r.fact_key_fp
             and (r.verdict <> 'reject' or (e.source_account_id = r.source_account_id and e.source_item_fp = r.source_item_fp))) as direct,
         exists (
           select 1 from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
           where r.fact_key_fp in (c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp) and c.fact_key_fp <> r.fact_key_fp
             and ((r.verdict = 'reject' and e.source_account_id = r.source_account_id and e.source_item_fp = r.source_item_fp)
               or (r.verdict in ('veto', 'retire') and exists (
                 select 1 from unnest(r.item_account_ids, r.item_fps) as i (account, item)
                 where i.account = e.source_account_id and i.item = e.source_item_fp)))) as carried
       from knowledge.belief_rulings r
       order by r.created_at, r.ruling_id collate "C"`,
    );
    return rows.map((row) => ({
      id: row.ruling_id,
      verdict: row.verdict,
      claim: row.claim_fp,
      factKey: row.fact_key_fp,
      at: stamp(row.created_at),
      liftedAt: stampOrNull(row.lifted_at),
      claimGone: !row.direct && !row.carried,
      ...(!row.direct && row.carried ? { carried: true as const } : {}),
    }));
  });
}

// An id that is no belief ruling but the owner's confirm of an about_you card lifts that confirmation, and the
// release it made (admin-release.ts). False for an id that is neither.
export async function liftRuling(admin: AdminContext, id: RulingId, options: { requestId: string }): Promise<boolean> {
  try {
    return await admin.transaction(async (query) => {
      const lifted = await liftIn(admin, query, id, options);
      // The card the owner answered waits for them again.
      if (lifted) await reopenAnswered(query, id, admin.now());
      return lifted;
    });
  } catch (error) {
    throw asRulingError(error);
  }
}

// One lift in the caller's transaction (`pi commitments reopen` too).
export async function liftIn(
  admin: AdminContext,
  query: Query,
  id: RulingId,
  options: { requestId: string },
): Promise<boolean> {
  const now = admin.now();
  await query(BELIEFS_LOCK);
  await lockRows(query, []);
  // A repeated request id returns the first result and writes nothing.
  const [repeat] = await query<{ supersedes: string | null; kind: string }>(
    "select supersedes, kind from knowledge.owner_decisions where request_id = $1",
    [options.requestId],
  );
  if (repeat !== undefined) {
    if (repeat.supersedes !== id || !repeat.kind.endsWith("_lift")) throw new AdminError("invalid_argument");
    return true;
  }
  const [ruling] = await query<{ verdict: Verdict; fact_key_fp: string; compartments: PersonalCompartment[] }>(
    "select verdict, fact_key_fp, compartments from knowledge.belief_rulings where ruling_id = $1 and lifted_at is null",
    [id],
  );
  if (ruling === undefined) {
    if (!(await liftConfirmation(admin, query, id, { requestId: options.requestId, now }))) return false;
    // An Edit's confirm lifts its correction with it, found by the request id the Edit gave it
    // (admin-reopen.ts editRequestId): the agent's claim counts again and the owner's claim is
    // rejected.
    const [answer] = await query<{ request_id: string }>(
      "select request_id from knowledge.owner_decisions where id = $1",
      [id],
    );
    const [correction] =
      answer === undefined
        ? []
        : await query<{ id: RulingId }>(
            "select o.id from knowledge.owner_decisions o join knowledge.belief_rulings r on r.ruling_id = o.id where o.request_id = $1 and r.lifted_at is null",
            [editRequestId(answer.request_id)],
          );
    if (correction !== undefined)
      await liftIn(admin, query, correction.id, { requestId: editRequestId(options.requestId) });
    return true;
  }
  const lift = await ownerDecision(
    query,
    { requestId: options.requestId, kind: LIFT[ruling.verdict], supersedes: id, compartments: ruling.compartments },
    now,
  );
  await liftRulings(query, "knowledge.belief_rulings", [id], lift, now);
  // One the owner rejected already stays as it is.
  const made = ruling.verdict === "reject" ? await correctionOf(query, admin.keys, id) : undefined;
  if (made !== undefined) {
    try {
      await ruleIn(admin, query, made, "reject", requestIdOf(`${options.requestId}:correction`));
    } catch (error) {
      if (!(error instanceof AdminError && error.code === "already_ruled")) throw error;
    }
  }
  // The lift of an Edit's correction lifts its confirm too, so the agent's words never stand as the
  // owner's confirmed ones, and the card waits for the owner again. The Edit's answer is the standing confirm of
  // the about-you card on this claim whose editRequestId is this ruling's.
  if (ruling.verdict === "reject") {
    const [own] = await query<{ request_id: string; claim_fp: string }>(
      "select o.request_id, r.claim_fp from knowledge.owner_decisions o join knowledge.belief_rulings r on r.ruling_id = o.id where o.id = $1",
      [id],
    );
    const answers =
      own === undefined
        ? []
        : await query<{ id: RulingId; request_id: string }>(
            `select o.id, o.request_id from knowledge.owner_decisions o join ledger.cards c on c.id = o.card_id
             where c.kind = 'about_you' and c.target_kind = 'claim' and c.target_id = $1 and o.kind = 'answer' and o.answer = 'confirm'
               and not exists (select 1 from knowledge.owner_decisions s where s.supersedes = o.id)`,
            [own.claim_fp],
          );
    const edit = answers.find((one) => editRequestId(one.request_id) === own?.request_id);
    if (
      edit !== undefined &&
      (await liftConfirmation(admin, query, edit.id, { requestId: editRequestId(options.requestId), now }))
    )
      await reopenAnswered(query, edit.id, now);
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// `pi facts show`
// ---------------------------------------------------------------------------------------------

export type ClaimRow = {
  id: FactId;
  type: string;
  // The capture item it cites, where the read asks for it.
  capture_id?: string | null;
  valid_from: Date;
  fact_key_fp: FactKeyFp;
  content_enc: Sealed | null;
  compartments: PersonalCompartment[];
  source_account_id: string;
  source_item_fp: string;
  message_id: string | null;
  // Drive: the document a claim of a document was said in, or null.
  document_id?: DocumentId | null;
  agent_app?: boolean | null;
  // Where the claim came from (ADMIN_FACT_SOURCE); absent where a statement reads none.
  source?: FactSource | null;
};

// The owner's account with the lowest id: the owner's id and address, as find_facts gives them.
const OWNER = `
  select a.entity_id, a.id, a.compartments, a.value_enc
  from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id
  where e.kind = 'owner'
  order by a.id
  limit 1`;
// The same among the accounts within `$1` alone, the one a client cleared for exactly those compartments would be
// given. The filter is in the statement, before the limit: a caller's filter of the one row returned would drop
// the owner whose lowest account is under another compartment.
const OWNER_WITHIN = OWNER.replace("where e.kind = 'owner'", "where e.kind = 'owner' and a.compartments <@ $1::text[]");

// A value of the claim on one line: text from evidence is quoted, so no character of it can end
// the line or pass for a line code wrote.
const quoted = (value: unknown): string => JSON.stringify(value) ?? "null";
const whoLine = (who: Who): string =>
  `${quoted(who.name?.untrusted ?? null)} ${quoted(who.address?.untrusted ?? null)} (${who.kind} ${who.id})`;
const valueLine = (value: unknown): string =>
  typeof value === "object" && value !== null && "kind" in value
    ? whoLine(value as Who)
    : quoted(
        typeof value === "object" && value !== null && "untrusted" in value
          ? (value as { untrusted: string }).untrusted
          : value,
      );

// Whether a claim is an agent's: an agent record's, or an agent app's moment's but for its project
// link and a claim code credited to the owner, their own prompt line.
const agentOutput = (record: ClaimRecord, row: ClaimRow, owner: string | undefined): boolean =>
  record.origin === "agent_record" ||
  (row.agent_app === true &&
    !LINK_TYPES.includes(row.type) &&
    (owner === undefined || record.claim.assertedBy !== owner));

// The claim as find_facts renders a fact for the owner, with its message id and under the admin's
// keys. It carries no belief status: the owner's belief's is listed beside it. With `within`, the
// owner's account and a person's name are those seen within those compartments alone.
export async function renderFact(
  admin: AdminContext,
  query: Query,
  row: ClaimRow,
  record: ClaimRecord,
  within?: readonly string[],
): Promise<FactView> {
  const ctx = ownerCtx(query, admin.keys, admin.log);
  const { claim } = record;
  const [ownerRow] = await (within === undefined
    ? query<ValueRow & { entity_id: string }>(OWNER)
    : query<ValueRow & { entity_id: string }>(OWNER_WITHIN, [[...within]]));
  const ownerAddress = ownerRow === undefined ? null : untrusted(ctx, "knowledge.accounts", "value_enc", ownerRow);
  const [ownerEntity] = await query<{ id: string }>(OWNER_ENTITY);
  const ids = [
    claim.content.subject,
    ...(claim.assertedBy === undefined ? [] : [claim.assertedBy]),
    ...Object.entries(claim.content.fields).flatMap(([field, value]) =>
      record.fieldKinds[field] === "entity" && typeof value === "string" ? [value] : [],
    ),
  ];
  const observed = ACTIVITY_FACT_TYPES.includes(row.type);
  const who = new Map(await whoOf(ctx, [...new Set(ids)], within === undefined ? undefined : { within }));
  if (observed) {
    const project = record.claim.content.fields.project;
    if (typeof project === "string") {
      const [row] = await query<ValueRow & { name_enc: Sealed }>(PROJECT_NAMES, [
        [project],
        within ?? (await ownerAudience(query)),
      ]);
      const name =
        row === undefined
          ? null
          : untrusted(ctx, "knowledge.projects", "name_enc", {
              id: row.id,
              compartments: row.compartments,
              value_enc: row.name_enc,
            });
      who.set(project, { id: project as EntityId, kind: "project", name, address: null });
    }
  }
  const whoIs = (id: unknown): Who => {
    if (typeof id !== "string") throw new Error("a person field that is no id");
    if (id === ownerRow?.entity_id || (record.subjectKind === "owner" && id === claim.content.subject))
      return { id: id as EntityId, kind: "owner", name: null, address: ownerAddress };
    const one = who.get(id);
    if (one === undefined) throw new Error("a person the claim names is not stored");
    return one;
  };
  const fields = Object.fromEntries(
    Object.entries(claim.content.fields).flatMap(([field, value]) => {
      if (value === undefined || value === null) return [];
      const kind = record.fieldKinds[field];
      if (kind === "entity") return [[field, whoIs(value)]];
      // An owner-side kind's key phrase as `what`, as find_facts serves it.
      if (kind === "text") return [[servedField(row.type, field), { untrusted: String(value) }]];
      return [[field, value]];
    }),
  );
  // A fact the owner's standing release kept, by the agent that quoted them: the granted-release tier
  // and that agent's name, so the owner's page says how it was kept.
  const granted =
    record.released?.grant === true
      ? (
          await query<{ client_name: string }>("select client_name from ledger.agent_writes where evidence_id = $1", [
            claim.primaryEvidenceId,
          ])
        )[0]?.client_name
      : undefined;
  const agentChat =
    row.agent_app === true &&
    !LINK_TYPES.includes(row.type) &&
    ownerEntity !== undefined &&
    claim.assertedBy === ownerEntity.id;
  return FactView.parse({
    ...(granted === undefined ? {} : { tier: "researched", channel: granted }),
    ...(agentChat ? { sourceMark: "agent_chat" } : {}),
    ...(observed ? { tier: "observed" } : {}),
    id: row.id,
    type: row.type,
    subject: whoIs(claim.content.subject),
    statedBy: claim.assertedBy === undefined ? null : whoIs(claim.assertedBy),
    basis: claim.basis,
    statementKind: claim.statementKind,
    at: stamp(row.valid_from),
    message: (row.document_id ?? null) === null ? row.message_id : null,
    document: row.document_id ?? null,
    passage: (row.document_id ?? null) === null ? null : passageOf(claim.evidence[0]?.span),
    // This read names no page fact.
    page: null,
    capture: observed ? (row.capture_id ?? null) : null,
    segment: null,
    thirdParty: record.disclosure.includes("third_party"),
    agentReported: agentOutput(record, row, ownerEntity?.id),
    provenance: agentOutput(record, row, ownerEntity?.id) ? "agent_reported" : "source",
    ...((row.source ?? null) === null ? {} : { source: row.source }),
    ...(claim.validTo !== undefined && VALID_TO_TYPES.has(row.type) ? { validTo: claim.validTo } : {}),
    fields,
  });
}

// The claim's detail, or null for an id that names no claim. `lines` mark every value with who
// wrote it: what the claim holds is its source's (an agent's, for an agent-reported claim), and
// the rest is code's.
export async function factShow(admin: AdminContext, id: FactId): Promise<FactDetail | null> {
  if (!FactId.safeParse(id).success) return null;
  return admin.transaction(async (query) => {
    const [row] = await query<ClaimRow>(
      `select c.id, c.type, c.valid_from, c.fact_key_fp, c.content_enc, c.compartments, e.source_account_id, e.source_item_fp, m.id as message_id, d.id as document_id, k.agent_app, k.id as capture_id, ${ADMIN_FACT_SOURCE} as source
       from knowledge.claims c
       join vault.evidence_items e on e.id = c.evidence_id
       left join knowledge.messages m on m.evidence_id = c.evidence_id
       left join knowledge.documents d on d.evidence_id = c.evidence_id
       left join knowledge.captures k on k.evidence_id = c.evidence_id
       where c.id = $1`,
      [id],
    );
    if (row === undefined) return null;
    const record = claimRecordUnder(admin.keys, row);
    const fact = await renderFact(admin, query, row, record);

    // The owner's belief of the fact, computed when asked: no audience keeps a copy, so there is
    // one belief or none.
    const beliefs = await ownerBeliefs({ query, keys: admin.keys }, [row.fact_key_fp]);
    const status = beliefs.map(({ belief }) => BeliefStatus.parse(belief.status));
    // The rulings in force that reach this claim: a reject of its item and fact key, a veto, a
    // retire, a domain or a kind of its fact key; and a reject of its item or a veto or retire
    // recorded on its item, by its version 1 key.
    const rulings = (
      await query<{ ruling_id: RulingId }>(
        `select r.ruling_id from knowledge.belief_rulings r, knowledge.claims c
         where c.id = $4 and r.lifted_at is null
           and ((r.fact_key_fp = $1 and (r.verdict <> 'reject' or (r.source_account_id = $2 and r.source_item_fp = $3)))
             or (r.fact_key_fp in (c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp) and r.fact_key_fp <> $1
               and ((r.verdict = 'reject' and r.source_account_id = $2 and r.source_item_fp = $3)
                 or (r.verdict in ('veto', 'retire') and exists (
                   select 1 from unnest(r.item_account_ids, r.item_fps) as i (account, item) where i.account = $2 and i.item = $3)))))
         order by r.created_at, r.ruling_id collate "C"`,
        [row.fact_key_fp, row.source_account_id, row.source_item_fp, row.id],
      )
    ).map((one) => one.ruling_id);
    const [declassified] = await query<{ ruling_id: RulingId }>(
      "select ruling_id from projections.declassified_facts where claim_fp = $1",
      [row.id],
    );

    const from: LineSource = fact.agentReported ? "agent" : "source";
    const code = (text: string): CardLine => ({ text, from: "code" });
    const lines: CardLine[] = [
      code(`fact: ${fact.id}`),
      code(`type: ${fact.type}`),
      code(`fact key: ${row.fact_key_fp}`),
      code(`compartments: ${row.compartments.join(",")}`),
      code(`at: ${fact.at}`),
      code(`message: ${fact.message ?? "none"}`),
      code(`basis: ${fact.basis}`),
      code(`statement: ${fact.statementKind}`),
      code(`third party: ${fact.thirdParty ? "yes" : "no"}`),
      code(`agent reported: ${fact.agentReported ? "yes" : "no"}`),
      { text: `subject: ${whoLine(fact.subject)}`, from },
      ...(fact.statedBy === null ? [] : [{ text: `stated by: ${whoLine(fact.statedBy)}`, from }]),
      ...Object.entries(fact.fields).map(([field, value]) => ({ text: `${field}: ${valueLine(value)}`, from })),
      code(
        `beliefs: ${beliefs.length} ${beliefs.length === 1 ? "audience" : "audiences"}${status.length === 0 ? "" : `, ${status.join(",")}`}`,
      ),
      ...rulings.map((ruling) => code(`ruling: ${ruling}`)),
      code(`declassification: ${declassified?.ruling_id ?? "none"}`),
    ];
    return FactDetail.parse({
      fact,
      factKey: row.fact_key_fp,
      compartments: row.compartments,
      beliefs: { audiences: beliefs.length, status },
      rulings,
      declassification: declassified?.ruling_id ?? null,
      lines,
    });
  });
}
