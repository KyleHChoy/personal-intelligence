import { CANARY_CLIENT_PREFIX, CANARY_COMPARTMENT, OPEN_IMPROVEMENT_STATUSES } from "@intelligence/contracts/personal";
import { type Fixed, fixed, type Sql, sql, sqlWords } from "./sql.ts";

// Statements more than one role sends, each stated once. Text only: a reader's policy is named by
// no statement here (admin/owner-reads-structure.test.ts), and statements.test.ts pins the text.
// Each is an `Sql` fragment, and each piece a function here takes is a literal or a fragment, never
// a string read at run time.

// A piece the type checker has already held to a literal or a fragment, as a fragment.
const piece = (text: string): Sql => text as Sql;

// A project's name within an audience; one outside it has no name.
export const PROJECT_NAMES = sql`select id, name_enc, compartments from knowledge.projects where id = any ($1::text[]) and compartments <@ $2::text[] order by id`;
// Which of these ids are people or organizations.
export const PERSON_OR_ORG_KINDS = sql`select e.id, e.kind from knowledge.entities e where e.id = any ($1::text[]) and e.kind in ('person', 'organization') order by e.id`;

// A ledger row's state is its latest event. `columns` are the event's columns to read, `kind` a row
// kind's word or an SQL expression for one, `row` an SQL expression for the row's id. `alias` is
// what the event table goes by in the statement, none for a statement of that table alone; `and` one
// more condition on the event.
export function latestRow<C extends string, K extends string, R extends string, A extends string, N extends string>(
  columns: Fixed<C>,
  kind: Fixed<K>,
  row: Fixed<R>,
  { alias = "r" as Fixed<A>, and }: { alias?: Fixed<A>; and?: Fixed<N> } = {},
): Sql {
  const at = alias === "" ? "" : `${alias}.`;
  const table = alias === "" ? "ledger.record_events" : `ledger.record_events ${alias}`;
  const word = /^[a-z_]+$/.test(kind) ? `'${kind}'` : kind;
  const also = and === undefined ? "" : ` and ${and}`;
  return piece(
    `select ${columns} from ${table} where ${at}row_kind = ${word} and ${at}row_id = ${row}${also} order by ${at}id desc limit 1`,
  );
}
export const latestEvent = <K extends string, R extends string, A extends string = "r">(
  kind: Fixed<K>,
  row: Fixed<R>,
  alias: Fixed<A> = "r" as Fixed<A>,
): Sql => latestRow(piece(`${alias}.event`), kind, row, { alias });

// A list of code words as SQL text literals, for `in (...)`. A value a caller sent is refused.
export const quoted = sqlWords;

// An improvement's status is its latest status event, else open: the event's `columns`, for a
// statement that aliases ledger.improvements as `i`; and whether that status is an open one.
export const improvementStatus = <C extends string = "e.status">(columns: Fixed<C> = "e.status" as Fixed<C>): Sql =>
  sql`select ${piece(columns)} from ledger.improvement_events e where e.improvement_id = i.id and e.event = 'status' order by e.created_at desc, e.id collate "C" desc limit 1`;
export const IMPROVEMENT_OPEN = sql`coalesce((${improvementStatus()}), 'open') in (${sqlWords(OPEN_IMPROVEMENT_STATUSES)})`;

// A move's status is its latest event but a report, which says what came of it and moves nothing.
export const moveStatus = <R extends string = "m.id", A extends string = "r">(
  row: Fixed<R> = "m.id" as Fixed<R>,
  alias: Fixed<A> = "r" as Fixed<A>,
): Sql => latestRow(piece(`${alias}.event`), "move", row, { alias, and: piece(`${alias}.event <> 'reported'`) });

// For a statement that aliases ledger.cards as `c`.
export const LATEST_CARD_EVENT = latestEvent("card", "c.id");
// The same, as a scalar on a card aliased `c`.
export const CARD_STATE = sql`(${LATEST_CARD_EVENT})`;
// The two counts of a wake's cards, as columns: the reasoner's deferred, and the pending within $1,
// the reasoner's compartments. A time card asks about the owner's own past time, so it never stops
// the planner.
export const WAKE_CARD_COUNTS = sql`(select count(*)::int from ledger.cards c where c.created_by = 'reasoner' and ${CARD_STATE} = 'deferred') as deferred,
       (select count(*)::int from ledger.cards c where ${CARD_STATE} = 'pending' and c.kind <> 'time_effort' and c.compartments <@ $1::text[]) as pending`;

// The kinds of ledger row a card's or a decision's target may be, with the table that holds each.
export const LEDGER_TARGET_TABLES = {
  card: "ledger.cards",
  // The send proxy's.
  draft: "ledger.drafts",
  send: "ledger.sent_messages",
  // Durable work's.
  run: "ledger.runs",
  hypothesis: "ledger.hypotheses",
  test: "ledger.hypothesis_tests",
  opportunity: "ledger.opportunities",
  move: "ledger.moves",
  intention: "ledger.intentions",
  // Research's.
  research_request: "ledger.research_requests",
  // Goal proposals.
  goal_proposal: "ledger.goal_proposals",
} as const;

// The role an opportunity goes to is the one its latest routing named, else the one it was made
// with. For a statement that aliases ledger.opportunities as `o`.
export const OPPORTUNITY_ROUTED = sql`select 1 from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id and r.event = 'routed'`;
export const ROUTED_ROLE = latestRow("r.role", "opportunity", "o.id", { and: "r.event = 'routed'" });

// The kill switch's state is its latest row: a safety control every path must read alike.
export const KILL_SWITCH_STATE = sql`select state from ledger.kill_switch order by id desc limit 1`;
export const KILL_SWITCH_ALIASED = sql`select k.state from ledger.kill_switch k order by k.id desc limit 1`;

// Who the owner is: the one entity of that kind.
export const OWNER_ENTITY = sql`select id from knowledge.entities where kind = 'owner'`;
export const OWNER_ENTITY_ALIASED = sql`select e.id from knowledge.entities e where e.kind = 'owner'`;
export const OWNER_ENTITY_ORDERED = sql`${OWNER_ENTITY_ALIASED} order by e.id`;
export const OWNER_ENTITY_FIRST = sql`${OWNER_ENTITY_ORDERED} limit 1`;
// The owner's addresses, by fingerprint.
export const OWNER_ACCOUNT_FPS = sql`select a.value_fp from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'owner'`;
// That `fp` is no address of the owner's. `who` is what the entity goes by in the statement.
export const notOwnerAddress = <F extends string, W extends string = "e">(
  fp: Fixed<F>,
  who: Fixed<W> = "e" as Fixed<W>,
): Sql =>
  piece(
    `not exists (select 1 from knowledge.accounts o join knowledge.entities ${who} on ${who}.id = o.entity_id where ${who}.kind = 'owner' and o.value_fp = ${fp})`,
  );

// What the standing end-to-end check owns is left out of the owner's reads. On a compartment `x`, for
// a read that holds no key set: isCanaryCompartment's rule in SQL.
export const NOT_CANARY_SQL = sql`x <> '${fixed(CANARY_COMPARTMENT)}' and not starts_with(x, 'agent:${fixed(CANARY_CLIENT_PREFIX)}')`;
// On a label column: no part of it is the check's.
export const noCanaryIn = <C extends string>(column: Fixed<C>): Sql =>
  sql`not exists (select 1 from unnest(${piece(column)}) as x where not (${NOT_CANARY_SQL}))`;
// On a client's name: not one of the check's clients.
export const notCanaryClient = <N extends string>(name: Fixed<N>): Sql =>
  sql`not starts_with(${piece(name)}, '${fixed(CANARY_CLIENT_PREFIX)}')`;

// A lesson in force is one whose latest event is the owner's confirmed, by this event and author.
export const LESSON_CONFIRMED = "confirmed/owner";
// A retired one's latest is the owner's retired. One text for the brief, the run, the tick and the
// owner's report.
export const LESSON_IN_FORCE = sql`h.kind = 'lesson' and h.tainted_at is null
      and (${latestRow("r.event || '/' || r.by", "hypothesis", "h.id")}) = '${fixed(LESSON_CONFIRMED)}'`;

// A row of the interaction log is direct when the owner sent the message, or the entity sent it to
// the owner. A co-recipient on mail the owner received is not. On a row aliased `i`.
const DIRECT_INBOUND = sql`i.direction = 'inbound' and i.entity_role = 'sender'`;
const DIRECT_OUTBOUND = sql`i.direction = 'outbound'`;
export const DIRECT_INTERACTION = sql`(${DIRECT_OUTBOUND} or (${DIRECT_INBOUND}))`;
// Distinct messages among such rows, by direction.
export const MAIL_COUNTS = sql`count(distinct i.evidence_id) filter (where ${DIRECT_INBOUND})::int as inbound,
    count(distinct i.evidence_id) filter (where ${DIRECT_OUTBOUND})::int as outbound`;
// Of the messages MAIL_COUNTS counts, those read by their headers alone: their rows
// are of the channel `mail_headers`, and no message row stands for them. Built from the same two
// predicates, so it can never count a message MAIL_COUNTS does not.
export const HEADERS_ONLY_COUNT = sql`count(distinct i.evidence_id) filter (where i.channel = 'mail_headers' and ${DIRECT_INTERACTION})::int as headers_only`;
// A claim of one of the owner's own saved contacts. On a claim aliased `c`.
export const OWN_CONTACT_CLAIM = sql`c.evidence_id in (select x.evidence_id from knowledge.contacts x where x.compartments = array['own']::text[])`;
// A message or a document that is not held, each aliased as a claim's joins alias them.
export const SOURCE_NOT_HELD = sql`(m.id is not null and not m.held) or (d.id is not null and not d.held)`;

// Who the identity sweep raises its cards as.
export const IDENTITY_AUTHOR = "system:identity";
