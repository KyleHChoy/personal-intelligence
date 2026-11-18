import {
  type CardId,
  type CardLabel,
  type CardState,
  type ClaimRef,
  CodedError,
  cardOptionsOf,
  DECISION_DETAILS,
  type DocumentId,
  type LedgerRef,
  type MessageId,
  NewCard,
  type OwnerDecisionDetails,
  type OwnerDecisionKind,
  type PersonalCompartment,
  type PersonalLogger,
  type PersonalRef,
  type RulingId,
} from "@intelligence/contracts/personal";
import { type Query, stamp } from "./db.ts";
import { newId } from "./ids.ts";
import type { Keys } from "./keys.ts";
import { authorWord, caseWord } from "./locks.ts";
import { sealUnder } from "./seal.ts";
import { CARD_STATE, latestRow } from "./statements.ts";

// The owner's queue and decisions, as free functions on a transaction's `query`, so a caller under
// any role that holds the grants calls them.

// A ref a caller holds as a fingerprint and no stored row: an address or
// a domain.
// Who expires a card deferred past its days (the tick), and the code on each event the expiry
// writes: the policy's, never the owner's own word (invariant 11).
export const CARD_EXPIRY = "system:card_expiry";
// Who gives back the status a card's expiry closed, when the owner reopens the card.
export const CARD_REOPEN = "system:card_reopen";
// The author of what the pipeline raises. The role's insert policy pins kind and author together.
export const EXTRACT_AUTHOR = "system:extract";
// The request id of a ruling a card's answer made, and that answer read back from it: a lift of the
// ruling reopens the card, so it is asked again.
export const cardRulingRequest = (answer: string): string => `card_${answer}`;
export const answerOfRulingRequest = (requestId: string): string | null =>
  requestId.startsWith("card_") ? requestId.slice("card_".length) : null;

export type FingerprintRef = { kind: "address" | "domain"; id: string };

export type Decision = {
  id: RulingId;
  requestId: string;
  kind: OwnerDecisionKind;
  target: PersonalRef | LedgerRef | ClaimRef | null;
  answer: string | null;
  card: CardId | null;
  supersedes: RulingId | null;
  batch: boolean;
  labels: CardLabel[];
  details: OwnerDecisionDetails;
  compartments: PersonalCompartment[];
  body?: { text: string; keys: Keys };
  // A target-less decision's keyed fingerprints of what it acts on, so
  // an erasure reaches it (ledger.taint_subject_decisions): a person's address and phone
  // fingerprints for a tier or a list, a commitment's fact key for its close and reopen.
  subjectFps?: string[];
};

// The kind with its own cap on the cards made: never held for a name. No cap holds back the cards
// shown: every card is raised pending.
export const OWN_CAP = "same_fact";

// A card's expiry: its fixed moment, or the time it became pending plus its days; null for a card
// with neither, and for one that counts in days and has not been pending. dispatch-read.ts's
// candidates state it in SQL so the tick need not open every card; this, read after the lock, decides.
export const cardExpiry = (fixed: Date | null, days: number | null, pendingAt: Date | null): Date | null =>
  fixed ?? (days === null || pendingAt === null ? null : new Date(pendingAt.getTime() + days * 86_400_000));

// A ledger row's state: its latest event's name, null before it has one.
export const latestOf = async (query: Query, rowKind: string, id: string): Promise<string | null> =>
  (await query<{ event: string }>(`${latestRow("event", "$1", "$2", { alias: "" })}`, [rowKind, id]))[0]?.event ?? null;

// A kind with no entry in DECISION_DETAILS takes the empty object and nothing else.
const parses = (kind: OwnerDecisionKind, details: unknown): boolean => {
  const schema = DECISION_DETAILS[kind];
  if (schema !== undefined) return schema.safeParse(details).success;
  return (
    typeof details === "object" && details !== null && !Array.isArray(details) && Object.keys(details).length === 0
  );
};

// The first statement of every transaction that writes a ledger row, also with an empty list.
export async function lockRows(query: Query, ids: string[]): Promise<void> {
  await query("select ledger.lock_rows($1)", [ids]);
}

export async function vetoedBy(
  query: Query,
  about: { refs: (PersonalRef | FingerprintRef)[]; kind?: string },
): Promise<RulingId | null> {
  const [row] = await query<{ ruling: RulingId | null }>("select policy.vetoed_by($1, $2, $3) as ruling", [
    about.refs.map((ref) => ref.kind),
    about.refs.map((ref) => ref.id),
    about.kind ?? null,
  ]);
  return row?.ruling ?? null;
}

export async function vetoed(
  query: Query,
  about: { refs: (PersonalRef | FingerprintRef)[]; kind?: string },
): Promise<boolean> {
  return (await vetoedBy(query, about)) !== null;
}

// Raises a card in the caller's transaction. A card
// whose author and request id, or whose undecided case key, is already there is returned and
// nothing is written: its state is answered as it stands, decided, expired or withdrawn included,
// with `replayed` true. A ref that does not resolve refuses
// the card with `not_found`, before anything is written. `keys` is needed only for a body: a
// body with no keys is a programming error. A rule may answer `withdrawn` for the kinds
// ledger.card_rule_stop names: a caller whose card stands for a row of its own closes that row.
export async function raiseCard(
  query: Query,
  card: NewCard,
  options: { now: Date; keys?: Keys; log?: PersonalLogger },
): Promise<{ id: CardId; state: CardState; replayed: boolean }> {
  const parsed = NewCard.safeParse(card);
  if (!parsed.success) throw new CodedError("invalid_argument");
  const allowed = cardOptionsOf(card.kind);
  if (allowed === undefined) throw new CodedError("not_built");
  if (!card.options.every((option) => allowed.includes(option))) throw new CodedError("invalid_argument");
  if (card.body !== null && options.keys === undefined) throw new Error("a card's body needs the keys");

  // The author's word, and the case's word its one undecided card.
  await lockRows(
    query,
    card.caseKey === null ? [authorWord(card.author)] : [authorWord(card.author), caseWord(card.caseKey)],
  );
  const [repeated] = await query<{ id: CardId; state: CardState }>(
    `select c.id, ${CARD_STATE} as state from ledger.cards c where c.created_by = $1 and c.request_id = $2`,
    [card.author, card.requestId],
  );
  if (repeated !== undefined) return { id: repeated.id, state: repeated.state, replayed: true };
  if (card.caseKey !== null) {
    const [open] = await query<{ id: CardId; state: "pending" | "deferred" }>(
      `select c.id, ${CARD_STATE} as state from ledger.cards c where c.case_key = $1 and ${CARD_STATE} in ('pending', 'deferred') order by c.created_at, c.id limit 1`,
      [card.caseKey],
    );
    if (open !== undefined) return { ...open, replayed: true };
  }

  if (card.refs.length > 0) {
    const [basis] = await query<{ ok: boolean }>("select ledger.add_basis('card', $1, $2, $3, $4, null) as ok", [
      card.id,
      card.compartments,
      card.refs.map((ref) => ref.kind),
      card.refs.map((ref) => ref.id),
    ]);
    if (basis?.ok !== true) throw new CodedError("not_found");
  }

  const state = "pending";
  const body =
    card.body === null || options.keys === undefined
      ? null
      : sealUnder(
          options.keys,
          card.compartments,
          { table: "ledger.cards", id: card.id, column: "body_enc" },
          card.body,
        );
  const at = stamp(options.now);
  await query(
    `insert into ledger.cards (id, request_id, created_at, created_by, run_id, kind, target_kind, target_id, options, expires_at, expires_after_days,
       case_key, body_from, body_enc, compartments)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ledger.label($15))`,
    [
      card.id,
      card.requestId,
      at,
      card.author,
      card.run,
      card.kind,
      card.target?.kind ?? null,
      card.target?.id ?? null,
      card.options,
      card.expiresAt,
      card.expiresAfterDays,
      card.caseKey,
      card.bodyFrom,
      body,
      card.compartments,
    ],
  );
  await query(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, $2, $3, $4, ledger.label($5))",
    [card.id, state, at, card.author, card.compartments],
  );
  // A rule the owner confirmed holds this question back: the card is on record, withdrawn at once, and
  // `pi cards reopen` gives it back.
  const [stopped] = await query<{ rule: string | null }>("select ledger.stop_card_by_rule($1) as rule", [card.id]);
  if (stopped?.rule != null) {
    options.log?.info({ event: "card_rule_stopped", ids: { card: card.id } });
    return { id: card.id, state: "withdrawn", replayed: false };
  }
  return { id: card.id, state, replayed: false };
}

// Its details parse with the kind's entry in DECISION_DETAILS, or as the strict empty object, or
// the decision is refused. A repeated request id returns the first ruling. `queue_depth` is the
// number of pending cards before it.
export async function writeDecision(query: Query, decision: Decision, options: { now: Date }): Promise<RulingId> {
  if (!parses(decision.kind, decision.details)) throw new CodedError("invalid_argument");
  const repeat = async (): Promise<RulingId | undefined> =>
    (
      await query<{ id: RulingId }>("select id from knowledge.owner_decisions where request_id = $1", [
        decision.requestId,
      ])
    )[0]?.id;
  const repeated = await repeat();
  if (repeated !== undefined) return repeated;
  const [pending] = await query<{ n: number }>(
    `select count(*)::int as n from ledger.cards c where ${CARD_STATE} = 'pending'`,
  );
  const body =
    decision.body === undefined
      ? null
      : sealUnder(
          decision.body.keys,
          decision.compartments,
          { table: "knowledge.owner_decisions", id: decision.id, column: "body_enc" },
          decision.body.text,
        );
  const inserted = await query(
    `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, card_id, supersedes, batch, queue_depth, labels,
       details, decided_at, body_enc, compartments, subject_fps)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ledger.label($15), $16)
     on conflict (request_id) do nothing returning id`,
    [
      decision.id,
      decision.requestId,
      decision.kind,
      decision.target?.kind ?? null,
      decision.target?.id ?? null,
      decision.answer,
      decision.card,
      decision.supersedes,
      decision.batch,
      pending?.n ?? 0,
      [...new Set(decision.labels)].sort(),
      decision.details,
      stamp(options.now),
      body,
      decision.compartments,
      [...new Set(decision.subjectFps ?? [])].sort(),
    ],
  );
  // A decision with the same request id committed while this one was written: the first.
  if (inserted.length === 0) return (await repeat()) ?? decision.id;
  return decision.id;
}

// Called after the release's own statements, in its transaction: the message row is locked first,
// as the writer's deletion locks it before the taint lock. A message's release, or a document's:
// the target's kind is its id's prefix.
export async function recordRelease(
  query: Query,
  message: MessageId | DocumentId,
  options: { requestId: string; batch: boolean; now: Date },
): Promise<RulingId> {
  await lockRows(query, []);
  const document = message.startsWith("doc_");
  const [row] = await query<{ compartments: PersonalCompartment[] }>(
    `select compartments from ${document ? "knowledge.documents" : "knowledge.messages"} where id = $1`,
    [message],
  );
  if (row === undefined) throw new CodedError("not_found");
  return writeDecision(
    query,
    {
      id: newId("rul") as RulingId,
      requestId: options.requestId,
      kind: "release",
      target: document
        ? { kind: "document", id: message as DocumentId }
        : { kind: "message", id: message as MessageId },
      answer: null,
      card: null,
      supersedes: null,
      batch: options.batch,
      labels: [],
      details: {},
      compartments: row.compartments,
    },
    { now: options.now },
  );
}
