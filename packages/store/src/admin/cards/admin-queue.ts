import type { Timestamp } from "@intelligence/contracts";
import {
  type CardAuthor,
  type CardDetail,
  CardId,
  type CardLine,
  type CardState,
  type CardsWithLines,
  type CardView,
  type ClaimRef,
  DecideArgs,
  DecideHandedArgs,
  declineAnswersOfCard,
  type FactId,
  isCoded,
  isRelayedConfirmKind,
  type LedgerRef,
  LineSource,
  type NewCard,
  type OwnerPageArgs,
  type PersonalCompartment,
  type PersonalRef,
  type RulingId,
  VetoArgs,
  type VetoView,
} from "@intelligence/contracts/personal";
import { SHOWN_TO_OWNER } from "../../cards/asked-less.ts";
import type { StoredCard } from "../../cards/card-kind-row.ts";
import { claimOf } from "../../cards/card-kinds-claims.ts";
import { agentLines } from "../../cards/questions-through-agent.ts";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError, asAdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { requestIdOf } from "../../core/ids.ts";
import type { Keys } from "../../core/keys.ts";
import { authorWord, BELIEFS_LOCK, NAME_HOLDS_LOCK } from "../../core/locks.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { cardExpiry, lockRows, OWN_CAP, raiseCard as raise } from "../../core/queue.ts";
import type { Sealed } from "../../core/seal.ts";
import { openUnder } from "../../core/seal.ts";
import { LATEST_CARD_EVENT, LEDGER_TARGET_TABLES, latestEvent, latestRow, noCanaryIn } from "../../core/statements.ts";
import { CARRY_CLAIM } from "../../erasure/taint.ts";
import { passedOverOn } from "../../identity/identity-questions.ts";
import { duplicatesOf, settleOnDecide } from "../../pipeline/fact-settlements.ts";
import { raiseOutcomeCard } from "../../work/dispatch-cards.ts";
import { cursorOf, ownerPage, ownerWho, ownerWithheld } from "../admin-owner.ts";
import { nameOf } from "../owner-names.ts";
import { correctIn } from "../people/owner-words.ts";
import { CARD_DECIDED, CARD_HELD, recordEvent } from "../record-event.ts";
import { answersTeach, proposeAfterAnswer } from "./admin-confirm-rates.ts";
import { type ViewSurface, writeView } from "./admin-learning.ts";
import { editRequestId } from "./admin-reopen.ts";
import { bodyLineOf, CARD_KINDS } from "./card-kinds.ts";

const LEDGER_TABLES: Readonly<Record<string, string>> = LEDGER_TARGET_TABLES;

// The admin's queue and veto methods, each in one transaction under the admin's keys and clock.

const LISTED = 10;
const LISTED_MOST = 50;

// A card's target kind's table: a kind not listed has no taint to find.
const PERSONAL_KINDS = new Set(["message", "event", "entity"]);

// A card as stored: what never changes, and nothing sealed.
type CardRow = {
  id: CardId;
  request_id: string;
  kind: string;
  created_by: CardAuthor;
  created_at: Date;
  options: string[];
  target_kind: string | null;
  target_id: string | null;
  compartments: PersonalCompartment[];
  case_key: string | null;
  run_id: string | null;
  body_from: string | null;
  expires_at: Date | null;
  expires_after_days: number | null;
};
const CARD_COLUMNS = `c.id, c.request_id, c.kind, c.created_by, c.created_at, c.options, c.target_kind, c.target_id, c.compartments, c.case_key, c.run_id, c.body_from,
  c.expires_at, c.expires_after_days`;

// A card's state, its taint and the time it became pending, read after its locks are held.
type CardStatus = { state: CardState; by: string; tainted: boolean; pending_at: Date | null };
const STATUS = `select (${LATEST_CARD_EVENT}) as state,
    (${latestRow("r.by", "card", "c.id")}) as by,
    c.tainted_at is not null as tainted,
    (select max(r.at) from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id and r.event = 'pending') as pending_at
  from ledger.cards c where c.id = $1`;

const targetOf = (row: CardRow): PersonalRef | LedgerRef | ClaimRef | null =>
  row.target_kind === null || row.target_id === null
    ? null
    : ({ kind: row.target_kind, id: row.target_id } as PersonalRef | LedgerRef | ClaimRef);

async function refsOf(query: Query, ids: string[]): Promise<Map<string, PersonalRef[]>> {
  const rows = await query<{ row_id: string; ref_kind: string; ref_id: string }>(
    "select row_id, ref_kind, ref_id from ledger.basis where row_kind = 'card' and row_id = any($1) and ref_kind <> $2 order by id",
    [ids, CARRY_CLAIM],
  );
  const refs = new Map<string, PersonalRef[]>();
  for (const row of rows)
    refs.set(row.row_id, [...(refs.get(row.row_id) ?? []), { kind: row.ref_kind, id: row.ref_id } as PersonalRef]);
  return refs;
}

const storedOf = (row: CardRow, refs: PersonalRef[]): StoredCard => ({
  id: row.id,
  kind: row.kind,
  author: row.created_by,
  createdAt: stamp(row.created_at),
  options: row.options,
  target: targetOf(row),
  requestId: row.request_id,
  refs,
  compartments: row.compartments,
  caseKey: row.case_key,
  run: row.run_id,
  bodyFrom: row.body_from === null ? null : LineSource.parse(row.body_from),
});

const viewOf = (row: CardRow, status: Pick<CardStatus, "state" | "pending_at">, refs: PersonalRef[]): CardView => {
  const expires = cardExpiry(row.expires_at, row.expires_after_days, status.pending_at);
  return {
    id: row.id,
    kind: row.kind,
    state: status.state,
    author: row.created_by,
    createdAt: stamp(row.created_at),
    expiresAt: expires === null ? null : (stamp(expires) as Timestamp),
    options: row.options,
    target: targetOf(row),
    refs,
  };
};

export async function raiseCard(
  admin: AdminContext,
  card: NewCard,
): Promise<{ id: CardId; state: CardState; replayed: boolean }> {
  try {
    return await admin.transaction((query) =>
      raise(query, card, { now: admin.now(), keys: admin.keys, log: admin.log }),
    );
  } catch (error) {
    throw asAdminError(error);
  }
}

// It writes nothing: the expiry's event is written by the lane or by the durable work tick. Nothing is opened,
// and no sealed column is read. The waiting cards' rows, as `listPending`, `cardsWithLines` and `learnedSince`
// read them: `p.at` is the time the card became pending, and `${now}` the admin's clock; a box health card
// waits its quiet hours.
export const WAITING = (now: string): string => `from ledger.cards c
       join lateral (${latestRow("r.event, r.at", "card", "c.id")}) p on true
       where p.event = 'pending' and ${noCanaryIn("c.compartments")} and ${SHOWN_TO_OWNER(now)}
         and coalesce(c.expires_at, p.at + make_interval(days => c.expires_after_days), 'infinity'::timestamptz) > ${now}`;

// What a card is about: its entity target, the entity its work (an opportunity, or a move's) is about, or
// the people and organizations its claim names (an agent's claim, a same-fact question). The rule is
// owner-names.ts `nameOf`: a person needs a name, an organization a name or its domain, and one the
// owner's Remove withheld has none; an id that is no person or organization (a project, the owner) holds
// nothing. One statement and the one naming lookup.
async function namelessOf(query: Query, keys: Keys, cards: string, params: unknown[]): Promise<Set<string>> {
  const rows = await query<{ id: string; entity: string }>(
    `with w as (${cards})
     select w.id, case when w.target_kind = 'entity' then w.target_id else o.about_id end as entity
     from w
     left join ledger.moves m on w.target_kind = 'move' and m.id = w.target_id
     left join ledger.opportunities o on o.id = case when w.target_kind = 'opportunity' then w.target_id when w.target_kind = 'move' then m.opportunity_id end and o.about_kind = 'entity'
     where w.target_kind = 'entity' or o.about_id is not null
     union all
     select w.id, e.entity_id from w join knowledge.claim_entities e on w.target_kind = 'claim' and e.claim_id = w.target_id`,
    params,
  );
  if (rows.length === 0) return new Set();
  const withheld = await ownerWithheld(query);
  const who = await ownerWho({ query, keys }, [...new Set(rows.map((row) => row.entity))]);
  const nameless = (id: string): boolean => who.has(id) && nameOf(who.get(id), withheld) === null;
  return new Set(rows.filter((row) => nameless(row.entity)).map((row) => row.id));
}

// The pending cards about someone with no name, held out of the page's waiting list and its count
// at once, before `sweepNameHolds` defers and holds them. Nothing is written.
export const heldForNames = (query: Query, keys: Keys, now: Date): Promise<Set<string>> =>
  namelessOf(query, keys, `select c.id, c.target_kind, c.target_id ${WAITING("$1")}`, [stamp(now)]);

// The open cards' latest state, and whether each is held for a name. A held card no longer open is
// read too, for its hold to be let go. `$1`: the admin's clock.
const OPEN_CARDS = `
  select c.id, c.kind, c.created_by, c.compartments, h.card_id is not null as held,
    c.tainted_at is null and (s.event = 'deferred' or (s.event = 'pending'
      and coalesce(c.expires_at, s.at + make_interval(days => c.expires_after_days), 'infinity'::timestamptz) > $1)) as open,
    s.event as state
  from ledger.cards c
  join lateral (${latestRow("r.event, r.at", "card", "c.id")}) s on true
  left join ledger.card_name_holds h on h.card_id = c.id
  where s.event in ('pending', 'deferred') or h.card_id is not null`;
const LATEST_STATE = `select c.id, (${LATEST_CARD_EVENT}) as state from ledger.cards c where c.id = any ($1::text[])`;

// A same_fact card is never held, so it is left to the read's filter. `pi web` runs it at its start
// and every NAME_HOLDS_MS.
export async function sweepNameHolds(admin: AdminContext): Promise<{ held: number; released: number }> {
  return admin.transaction(async (query) => {
    await query(NAME_HOLDS_LOCK);
    const rows = await query<{
      id: string;
      kind: string;
      created_by: string;
      compartments: string[];
      state: string;
      held: boolean;
      open: boolean;
    }>(OPEN_CARDS, [stamp(admin.now())]);
    const open = rows.filter((row) => row.open && row.kind !== OWN_CAP);
    const nameless =
      open.length === 0
        ? new Set<string>()
        : await namelessOf(
            query,
            admin.keys,
            "select c.id, c.target_kind, c.target_id from ledger.cards c where c.id = any ($1::text[])",
            [open.map((row) => row.id)],
          );
    const changing = rows.filter((row) => nameless.has(row.id) !== row.held);
    if (changing.length === 0) return { held: 0, released: 0 };
    await lockRows(
      query,
      changing.map((row) => row.id),
    );
    const now = new Map(
      (await query<{ id: string; state: string }>(LATEST_STATE, [changing.map((row) => row.id)])).map((row) => [
        row.id,
        row.state,
      ]),
    );
    const at = stamp(admin.now());
    const authors = new Set<string>();
    let held = 0;
    let released = 0;
    for (const row of changing) {
      const hold = nameless.has(row.id) && now.get(row.id) === row.state;
      if (hold && !row.held) {
        await query("insert into ledger.card_name_holds (card_id, held_at) values ($1, $2)", [row.id, at]);
        if (row.state === "pending") await recordEvent(query, CARD_HELD, row.id, at, row.compartments);
        held += 1;
        authors.add(row.created_by);
      } else if (!hold && row.held) {
        await query("delete from ledger.card_name_holds where card_id = $1", [row.id]);
        released += 1;
        authors.add(row.created_by);
      }
    }
    for (const author of authors) await query("select ledger.admit_deferred($1)", [author]);
    return { held, released };
  });
}

// The held cards still deferred: Settings counts them with the pending ones the read holds.
export async function heldDeferred(query: Query): Promise<number> {
  const [row] = await query<{ n: number }>(
    `select count(*)::int as n from ledger.card_name_holds h join ledger.cards c on c.id = h.card_id
     where c.tainted_at is null and (${latestEvent("card", "h.card_id")}) = 'deferred'`,
  );
  return row?.n ?? 0;
}

export async function listPending(
  admin: AdminContext,
  options: { kind?: string; limit?: number } = {},
): Promise<CardView[]> {
  const limit = options.limit ?? LISTED;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LISTED_MOST) throw new AdminError("invalid_argument");
  return admin.transaction((query) =>
    waitingViews(query, admin.now(), options.kind === undefined ? null : [options.kind], limit),
  );
}

// `targets`: only cards whose target is one of these rows, as a goal's proposals are read.
export async function waitingViews(
  query: Query,
  now: Date,
  kinds: readonly string[] | null,
  limit: number,
  targets: readonly string[] | null = null,
): Promise<CardView[]> {
  const rows = await query<CardRow & { pending_at: Date | null }>(
    `select ${CARD_COLUMNS}, p.at as pending_at
     ${WAITING("$3")}
       and ($1::text[] is null or c.kind = any ($1::text[]))
       and ($4::text[] is null or c.target_id = any ($4::text[]))
     order by c.created_at, c.id
     limit $2`,
    [kinds === null ? null : [...kinds], limit, stamp(now), targets === null ? null : [...targets]],
  );
  const refs = await refsOf(
    query,
    rows.map((row) => row.id),
  );
  return rows.map((row) => viewOf(row, { state: "pending", pending_at: row.pending_at }, refs.get(row.id) ?? []));
}

// The outcome cards on work handed to the owner that wait for their answer, in the caller's
// transaction: pending and unexpired by `listPending`'s rules, or held back by the card cap
// (`deferred`), which `decide` answers too. Two statements; none when no work is named.
export async function handedOutcomeViews(
  query: Query,
  now: Date,
  opportunities: readonly string[],
): Promise<CardView[]> {
  if (opportunities.length === 0) return [];
  const rows = await query<CardRow & { state: "pending" | "deferred"; pending_at: Date | null }>(
    `select ${CARD_COLUMNS}, p.event as state, case when p.event = 'pending' then p.at end as pending_at from ledger.cards c
       join lateral (${latestRow("r.event, r.at", "card", "c.id")}) p on true
     where c.kind = 'outcome' and c.target_kind = 'opportunity' and c.target_id = any ($1::text[]) and c.tainted_at is null
       and (p.event = 'deferred' or (p.event = 'pending' and coalesce(c.expires_at, p.at + make_interval(days => c.expires_after_days), 'infinity'::timestamptz) > $2))
     order by c.created_at, c.id`,
    [[...opportunities], stamp(now)],
  );
  const refs = await refsOf(
    query,
    rows.map((row) => row.id),
  );
  return rows.map((row) => viewOf(row, { state: row.state, pending_at: row.pending_at }, refs.get(row.id) ?? []));
}

// One card for the owner's terminal: its kind's lines, then its body as one line marked with who
// wrote it. A body whose compartment key the key file lacks is one code line, `body_unreadable`.
// With `view`, the owner's `pi show` or web card page: one ledger.owner_views row in this read.
export async function card(
  admin: AdminContext,
  id: CardId,
  options: { view?: ViewSurface } = {},
): Promise<CardDetail | null> {
  return admin.transaction(async (query) => {
    const [row] = await query<CardRow & { body_enc: Sealed }>(
      `select ${CARD_COLUMNS}, c.body_enc from ledger.cards c where c.id = $1`,
      [id],
    );
    if (row === undefined) return null;
    if (options.view !== undefined) await writeView(query, { kind: "card", id }, options.view, admin.now());
    const [status] = await query<CardStatus>(STATUS, [id]);
    const refs = (await refsOf(query, [id])).get(id) ?? [];
    return {
      ...viewOf(row, status ?? { state: "pending", pending_at: null }, refs),
      lines: await linesOf(admin, query, row, refs),
    };
  });
}

// The cards named, as `card` shows each, in the caller's transaction, for the ledger's feed ("Your
// decisions" names the card each answer was on). Untainted ones within `compartments` only; no view
// is recorded: the owner did not open them. Three statements, then each card's lines.
export async function cardsShown(
  admin: AdminContext,
  query: Query,
  ids: readonly string[],
  compartments: readonly string[],
): Promise<CardDetail[]> {
  if (ids.length === 0) return [];
  const rows = await query<CardRow & { body_enc: Sealed }>(
    `select ${CARD_COLUMNS}, c.body_enc from ledger.cards c where c.id = any ($1::text[]) and c.tainted_at is null and c.compartments <@ $2::text[] order by c.id`,
    [[...ids], [...compartments]],
  );
  if (rows.length === 0) return [];
  const states = await query<CardStatus & { id: string }>(
    `select c.id, (${LATEST_CARD_EVENT}) as state,
       false as tainted, null::timestamptz as pending_at
     from ledger.cards c where c.id = any ($1::text[])`,
    [rows.map((row) => row.id)],
  );
  const refs = await refsOf(
    query,
    rows.map((row) => row.id),
  );
  const shown: CardDetail[] = [];
  for (const row of rows) {
    const one = refs.get(row.id) ?? [];
    const status = states.find((state) => state.id === row.id);
    shown.push({
      ...viewOf(row, status ?? { state: "pending", pending_at: null }, one),
      lines: await linesOf(admin, query, row, one),
    });
  }
  return shown;
}

// A card's lines, as `card` shows them.
async function linesOf(
  admin: AdminContext,
  query: Query,
  row: CardRow & { body_enc: Sealed },
  refs: PersonalRef[],
): Promise<CardLine[]> {
  const stored = storedOf(row, refs);
  let body: string | null = null;
  let unreadable = false;
  if (row.body_enc !== null) {
    try {
      body = openUnder(
        admin.keys,
        row.compartments,
        { table: "ledger.cards", id: row.id, column: "body_enc" },
        row.body_enc,
      );
    } catch (error) {
      if (!isCoded(error, "unknown_compartment")) throw error;
      unreadable = true;
    }
  }
  const kind = Object.hasOwn(CARD_KINDS, row.kind) ? CARD_KINDS[row.kind] : undefined;
  const lines: CardLine[] =
    kind === undefined
      ? []
      : [
          ...(await kind.render(stored, () => body, { query, keys: admin.keys })),
          ...((await kind.detail?.(query, stored, admin.keys)) ?? []),
          ...(await agentLines(query, stored)),
        ];
  lines.push(...bodyLineOf(kind, body, stored.bodyFrom, unreadable));
  return lines;
}

// It records no view: a card is opened, and its view written, only by `card` when the owner opens
// it. A card is the owner's own ledger row, which pi_reader never reads, so no reader filter
// applies; it shows every card `listPending` and `card` show, a body the key file cannot open as
// `body_unreadable`. Statements: the page, its refs in one batch, then each kind's own render and
// detail reads for each card (`card`'s, unchanged). The place: the card's creation time to the
// microsecond, in the form the read issues it, and its id. A time of any other form, or no real
// date, is refused before Postgres casts it.
export const PLACE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const isPlaceTime = (value: unknown): boolean =>
  typeof value === "string" &&
  PLACE_TIME.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString().slice(0, 19) === value.slice(0, 19);

export async function cardsWithLines(admin: AdminContext, args: OwnerPageArgs = {}): Promise<CardsWithLines> {
  const page = ownerPage(
    args,
    (place) => place.length === 2 && isPlaceTime(place[0]) && CardId.safeParse(place[1]).success,
  );
  return admin.transaction(async (query) => {
    // A card about someone with no name waits out of the page until they have one.
    const held = await heldForNames(query, admin.keys, admin.now());
    const rows = await query<CardRow & { body_enc: Sealed; pending_at: Date; place_at: string }>(
      `select ${CARD_COLUMNS}, c.body_enc, p.at as pending_at, to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as place_at
       ${WAITING("$1")}
         and ($2::timestamptz is null or (c.created_at, c.id) > ($2::timestamptz, $3::text))
         and not (c.id = any ($5::text[]))
       order by c.created_at, c.id
       limit $4`,
      [stamp(admin.now()), page.after?.[0] ?? null, page.after?.[1] ?? null, page.limit + 1, [...held]],
    );
    const kept = rows.slice(0, page.limit);
    const refs = await refsOf(
      query,
      kept.map((row) => row.id),
    );
    const cards: CardDetail[] = [];
    for (const row of kept) {
      const cardRefs = refs.get(row.id) ?? [];
      cards.push({
        ...viewOf(row, { state: "pending", pending_at: row.pending_at }, cardRefs),
        lines: await linesOf(admin, query, row, cardRefs),
      });
    }
    const last = kept.at(-1);
    return { cards, next: rows.length > page.limit && last !== undefined ? cursorOf([last.place_at, last.id]) : null };
  });
}

// Each card's own request id, from the command's: a repeat of the command finds its rulings.
const cardRequestId = (requestId: string, id: CardId): string => requestIdOf(`${requestId}:${id}`);

// One refused card refuses the command.
type Decided = { card: CardId; ruling: RulingId; passedOver?: number };

// Then, once for the batch, the confirm rates' pass when an about-you card is answered for the first
// time; its failure never fails the decision. Pairs on a batch card the answer could not land on are
// told to the owner, never left to find out.
// `relayed`: the owner's process applies an agent's relay (admin-relays.ts); no route passes it.
export async function decide(
  admin: AdminContext,
  args: DecideArgs,
  { relayed = false }: { relayed?: boolean } = {},
): Promise<Decided[]> {
  if (!DecideArgs.safeParse(args).success) throw new AdminError("invalid_argument");
  // The owner's expectation is not written here: it is refused, never dropped.
  if (args.expect !== undefined) throw new AdminError("not_built");
  // A relayed answer teaches nothing and proposes nothing: it is no confirmation of the owner's own.
  const teaches = !relayed && (await answersTeach(admin, args.cards));
  const now = admin.now();
  let decided: Decided[];
  try {
    decided = await admin.transaction((query) => decideIn(admin, query, args, now, relayed));
  } catch (error) {
    throw asAdminError(error);
  }
  if (teaches) await proposeAfterAnswer(admin);
  const passed = await admin.transaction((query) => passedOverOn(query, args.cards));
  return decided.map((one) => {
    const n = passed.find((row) => row.card_id === one.card)?.n;
    return n === undefined ? one : { ...one, passedOver: n };
  });
}

// The owner's Done or Drop on work handed to them, from the work's own row, whether or not its
// outcome card is live. One transaction: the live card (pending or deferred) is answered; with none
// (the tick has not raised it yet, or each one raised ended unanswered) one is raised now, past
// OUTCOME_RERAISES, under a request id made from the owner's, so a repeat finds the same card and
// `decide` answers it with its first ruling.
export async function decideHanded(
  admin: AdminContext,
  args: DecideHandedArgs,
): Promise<{ card: CardId; ruling: RulingId }[]> {
  if (!DecideHandedArgs.safeParse(args).success) throw new AdminError("invalid_argument");
  const now = admin.now();
  try {
    return await admin.transaction(async (query) => {
      const [live] = await query<{ id: CardId }>(
        `select c.id from ledger.cards c
           join lateral (${LATEST_CARD_EVENT}) p on true
         where c.kind = 'outcome' and c.target_kind = 'opportunity' and c.target_id = $1 and c.tainted_at is null and p.event in ('pending', 'deferred')
         order by c.created_at desc, c.id desc limit 1`,
        [args.opportunity],
      );
      const raised = requestIdOf(`handed:${args.requestId}`);
      const [repeat] =
        live === undefined
          ? await query<{ id: CardId }>(
              "select id from ledger.cards where kind = 'outcome' and target_id = $1 and request_id = $2",
              [args.opportunity, raised],
            )
          : [];
      const card =
        live?.id ??
        repeat?.id ??
        (await raiseOutcomeCard(query, { kind: "opportunity", id: args.opportunity }, now, undefined, {
          requestId: raised,
        }));
      if (card === null) throw new AdminError("not_found");
      const { opportunity: _opportunity, ...answer } = args;
      return decideIn(admin, query, { ...answer, cards: [card] }, now);
    });
  } catch (error) {
    throw asAdminError(error);
  }
}

// `relayed`: the answer is an agent's relay of the owner's words, applied by the owner's process
// (admin-relays.ts), never a route's argument. On a kind of RELAYED_CONFIRM_KINDS it runs no effect
// (so a statement about the owner releases nothing) and settles no other card on its fact: only
// the owner's own confirm and reject do; policy.relayed_claims reads it, at its own tier.
async function decideIn(
  admin: AdminContext,
  query: Query,
  args: DecideArgs,
  now: Date,
  relayed = false,
): Promise<{ card: CardId; ruling: RulingId }[]> {
  // What never changes, read before the locks: each card's target, author and kind.
  const rows = await query<CardRow>(`select ${CARD_COLUMNS} from ledger.cards c where c.id = any($1)`, [args.cards]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const refs = await refsOf(query, args.cards);
  const cards = args.cards.map((id) => {
    const row = byId.get(id);
    if (row === undefined) throw new AdminError("not_found");
    const kind = Object.hasOwn(CARD_KINDS, row.kind) ? CARD_KINDS[row.kind] : undefined;
    if (kind === undefined) throw new AdminError("not_built");
    return { row, kind, stored: storedOf(row, refs.get(id) ?? []) };
  });
  const ids = new Set<string>();
  for (const { row, kind, stored } of cards) {
    ids.add(row.id);
    if (row.target_kind !== null && row.target_id !== null && !PERSONAL_KINDS.has(row.target_kind))
      ids.add(row.target_id);
    for (const id of (await kind.lockIds?.(query, stored)) ?? []) ids.add(id);
    ids.add(authorWord(row.created_by));
  }
  // The other cards on each answered fact's match key, which its answer may withdraw.
  for (const id of await duplicatesOf(query, rows)) ids.add(id);
  // An about-you card's Edit rules on its fact, so the beliefs lock is taken first, as every ruling
  // takes it.
  if (args.correct !== undefined) {
    if (cards.some(({ row }) => row.kind !== "about_you")) throw new AdminError("invalid_argument");
    await query(BELIEFS_LOCK);
  }
  await lockRows(query, [...ids]);

  const decided: { card: CardId; ruling: RulingId }[] = [];
  for (const { row, kind, stored } of cards) {
    const requestId = cardRequestId(args.requestId, row.id);
    const [repeat] = await query<{ id: RulingId }>("select id from knowledge.owner_decisions where request_id = $1", [
      requestId,
    ]);
    if (repeat !== undefined) {
      decided.push({ card: row.id, ruling: repeat.id });
      continue;
    }
    if (!row.options.includes(args.answer)) throw new AdminError("invalid_answer");
    // A reason only on a kind's no (DECLINE_ANSWERS), never on another answer; on an outcome
    // card, only where its dismiss is the owner's no on a handed opportunity.
    if (
      args.reason !== undefined &&
      !declineAnswersOfCard({ kind: row.kind, target: targetOf(row) }).includes(args.answer)
    )
      throw new AdminError("invalid_argument");
    const [status] = await query<CardStatus>(STATUS, [row.id]);
    const open = status?.state === "pending" || status?.state === "deferred";
    if (status === undefined || !open || status.tainted) throw new AdminError("not_pending");
    const expires = cardExpiry(
      row.expires_at,
      row.expires_after_days,
      status.state === "pending" ? status.pending_at : null,
    );
    if (expires !== null && expires.getTime() <= now.getTime()) throw new AdminError("not_pending");
    const table = row.target_kind === null ? undefined : LEDGER_TABLES[row.target_kind];
    if (table !== undefined) {
      const [target] = await query<{ tainted: boolean }>(
        `select tainted_at is not null as tainted from ${table} where id = $1`,
        [row.target_id],
      );
      if (target?.tainted === true) throw new AdminError("not_pending");
    }

    const ruling = await ownerDecision(
      query,
      {
        requestId,
        kind: "answer",
        target: targetOf(row),
        answer: args.answer,
        card: row.id,
        batch: args.cards.length > 1,
        labels: args.labels ?? [],
        compartments: row.compartments,
        ...(args.note === undefined ? {} : { body: { text: args.note, keys: admin.keys } }),
      },
      now,
    );
    await recordEvent(query, CARD_DECIDED, row.id, stamp(now), row.compartments);
    // A compartment is taken only where the kind reads it.
    if (args.compartment !== undefined && kind.takesCompartment?.(args.answer) !== true)
      throw new AdminError("invalid_argument");
    // On a claim's card a relayed answer runs no effect and settles nothing. A relay carries no
    // correction (decideRelayed passes none); one that did is refused, never applied as an Edit.
    if (relayed && isRelayedConfirmKind(row.kind)) {
      if (args.correct !== undefined) throw new AdminError("invalid_argument");
    } else if (args.correct === undefined) {
      await kind.effect({
        query,
        card: stored,
        answer: args.answer,
        ruling,
        now,
        keys: admin.keys,
        note: args.note,
        reason: args.reason,
        compartment: args.compartment,
        relayed,
      });
      // The answer from the owner settles the claims waiting on the card and withdraws the other undecided
      // cards on its fact, but those named in this call.
      await settleOnDecide(query, row, args.answer, args.cards);
    } else {
      // Edit. The owner's confirm releases nothing of the agent's: in the same transaction the agent's
      // claim is rejected and the owner's value kept as their own words, under the agent fact's whole
      // label, which outranks the agent's (invariant 11). The lift of this answer lifts the correction
      // with it (admin-rulings.ts). The other cards on its fact are settled as the owner's reject of
      // the agent's words. A card on a fact read from the owner's mail (a need they asked) takes their
      // Edit the same way: the claim from their mail is rejected and their words kept.
      const found = await claimOf(stored, { query, keys: admin.keys });
      if (typeof found === "string") throw new AdminError("invalid_argument");
      await correctIn(admin, query, found.id as FactId, args.correct, editRequestId(requestId));
      await settleOnDecide(query, row, "reject", args.cards);
    }
    await query("select ledger.admit_deferred($1)", [row.created_by]);
    decided.push({ card: row.id, ruling });
  }
  return decided;
}

// The owner's entity and an id that does not exist are `not_found`.
export async function addVeto(admin: AdminContext, args: VetoArgs, options: { requestId: string }): Promise<RulingId> {
  if (!VetoArgs.safeParse(args).success) throw new AdminError("invalid_argument");
  const now = admin.now();
  try {
    return await admin.transaction(async (query) => {
      await lockRows(query, []);
      let subject: "person" | "organization" | "any" = "any";
      let fps: string[] = [];
      let compartments: string[] = ["own"];
      if (args.entity !== undefined) {
        const [entity] = await query<{ kind: string }>("select kind from knowledge.entities where id = $1", [
          args.entity,
        ]);
        const held =
          entity?.kind === "person"
            ? await query<{ fp: string; compartments: string[] }>(
                "select value_fp as fp, compartments from knowledge.accounts where entity_id = $1",
                [args.entity],
              )
            : entity?.kind === "organization"
              ? await query<{ fp: string; compartments: string[] }>(
                  "select domain_fp as fp, compartments from knowledge.domains where entity_id = $1",
                  [args.entity],
                )
              : [];
        if (held.length === 0) throw new AdminError("not_found");
        subject = entity?.kind === "person" ? "person" : "organization";
        fps = [...new Set(held.map((row) => row.fp))].sort();
        compartments = [...new Set(held.flatMap((row) => row.compartments))].sort();
      }
      const ruling = await ownerDecision(
        query,
        {
          requestId: options.requestId,
          kind: "veto",
          target: args.entity === undefined ? null : { kind: "entity", id: args.entity },
          compartments: compartments,
        },
        now,
      );
      // A repeated request id returns the first ruling, whose veto is already written.
      await query(
        `insert into knowledge.vetoes (ruling_id, subject, value_fps, work_kind, created_at, compartments)
         values ($1, $2, $3, $4, $5, ledger.label($6)) on conflict (ruling_id) do nothing`,
        [ruling, subject, fps, args.kind ?? null, stamp(now), compartments],
      );
      return ruling;
    });
  } catch (error) {
    throw asAdminError(error);
  }
}

// Every standing veto, oldest first, with the entity that holds one of its fingerprints now,
// or null. A lifted veto is not listed: the view has no word for it.
export async function listVetoes(admin: AdminContext): Promise<VetoView[]> {
  return admin.transaction(async (query) => {
    const listed = await query<{
      ruling_id: RulingId;
      subject: VetoView["subject"];
      work_kind: string | null;
      created_at: Date;
      entity: string | null;
    }>(
      `select v.ruling_id, v.subject, v.work_kind, v.created_at,
         case v.subject
           when 'person' then (select min(a.entity_id) from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id
                               where e.kind = 'person' and a.value_fp = any (v.value_fps))
           when 'organization' then (select min(d.entity_id) from knowledge.domains d where d.domain_fp = any (v.value_fps))
         end as entity
       from knowledge.vetoes v where v.lifted_at is null
       order by v.created_at, v.ruling_id collate "C"`,
    );
    return listed.map((row) => ({
      id: row.ruling_id,
      subject: row.subject,
      entity: row.entity as VetoView["entity"],
      kind: row.work_kind,
      at: stamp(row.created_at),
    }));
  });
}

// False for an id that is no veto, or one already lifted.
export async function liftVeto(admin: AdminContext, id: RulingId, options: { requestId: string }): Promise<boolean> {
  const now = admin.now();
  try {
    return await admin.transaction(async (query) => {
      await lockRows(query, [id]);
      // One that lifted another veto is refused.
      const [repeat] = await query<{ supersedes: string | null }>(
        "select supersedes from knowledge.owner_decisions where request_id = $1",
        [options.requestId],
      );
      if (repeat !== undefined) {
        if (repeat.supersedes !== id) throw new AdminError("invalid_argument");
        return true;
      }
      const [veto] = await query<{ compartments: PersonalCompartment[] }>(
        "select compartments from knowledge.vetoes where ruling_id = $1 and lifted_at is null",
        [id],
      );
      if (veto === undefined) return false;
      const ruling = await ownerDecision(
        query,
        { requestId: options.requestId, kind: "veto_lift", supersedes: id, compartments: veto.compartments },
        now,
      );
      await query("update knowledge.vetoes set lifted_at = $2, lift_ruling_id = $3 where ruling_id = $1", [
        id,
        stamp(now),
        ruling,
      ]);
      return true;
    });
  } catch (error) {
    throw asAdminError(error);
  }
}
