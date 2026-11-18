import { OWN_CONTACT_CLAIM } from "./statements.ts";

// What a reader may be served of a claim (`c`), stated once: the rules every read and the owner's
// reads build their statements from. Each is SQL text over the caller's row policies, so one
// statement serves every audience and sends the same text whatever rows exist (invariant 6).

// A released claim (the owner's own fact) counts only while its release is in force, so a tainted
// confirm, a lift or a veto drops it at once (invariant 10).
export const RELEASE_IN_FORCE = `(not c.released or c.evidence_id in (select r.evidence_id from policy.released_records() r))`;

// The claim's agent record, one the caller's token returns and not flagged: a finding's source. The
// records are read once, as a set, whatever the claims.
export const RECORD_SHOWN = `c.evidence_id in (select w.evidence_id from ledger.agent_writes w where w.evidence_id is not null and w.flagged_at is null)`;
const recordColumn = (column: "id" | "client_name"): string =>
  `(select w.${column} from ledger.agent_writes w where w.evidence_id = c.evidence_id and w.flagged_at is null order by w.id limit 1)`;
// That record's id, the first by id.
export const RECORD_ID = recordColumn("id");
// The record's id and the client that wrote it, as `record_id` and `record_client`, when `when`
// holds: a quoted proposal's or an answer's channel.
export const recordOf = (when: string): string =>
  `(case when ${when} then ${RECORD_ID} end) as record_id,
    (case when ${when} then ${recordColumn("client_name")} end) as record_client`;

// An agent record (`w`) a live correction replaced is left out. The function is asked only of a
// record that a record the caller reads supersedes (one probe of agent_writes_supersedes, under
// the same row policy), and `case` keeps that order, so the cheap probe runs first. The probe's `c`
// is its own, inside its subquery, whatever `c` names outside it.
export const CORRECTED = `case when exists (select 1 from ledger.agent_writes c where c.supersedes = w.id)
      then exists (select 1 from policy.live_corrections(array[w.id])) else false end`;

// The entity kinds a claim may name.
export type NamedKind = "owner" | "person" | "organization" | "project";
const kindList = (kinds: readonly NamedKind[]): string => kinds.map((kind) => `'${kind}'`).join(", ");

// The claim names no entity of these kinds the token does not show: each named entity is probed by
// its id, so the rule reads one entity row per name and never a set of them. The owner's reads also
// name the ids they withheld, bound at `withheld`, which pi_admin's policies do not hide.
export const namesShown = (kinds: readonly NamedKind[], withheld?: string): string => {
  const hidden = `(select e.id from knowledge.entities e where e.id = n.entity_id and e.kind in (${kindList(kinds)})) is null`;
  return `not exists (
      select 1 from knowledge.claim_entities n
      where n.claim_id = c.id
        and ${withheld === undefined ? hidden : `(n.entity_id = any(${withheld}::text[]) or ${hidden})`})`;
};
// find_facts' form: no person, organization or project the token does not show.
export const NAMES_SHOWN = namesShown(["person", "organization", "project"]);

// The items a claim's evidence may be, each a table joined on the claim's evidence under its alias,
// and what of a row the reader may be shown. A capture item with its event counts only once its
// meeting is linked to an event.
const ITEMS = {
  message: { alias: "m", table: "knowledge.messages", shown: "not m.held" },
  document: { alias: "d", table: "knowledge.documents", shown: "not d.held" },
  page: { alias: "g", table: "knowledge.pages", shown: "" },
  capture: { alias: "k", table: "knowledge.captures", shown: "" },
  linkedCapture: { alias: "k", table: "knowledge.captures", shown: "k.event_id is not null" },
} as const;
export type SourceItem = keyof typeof ITEMS;

// What serves a claim whose evidence is none of the items: a released claim, a finding's record,
// or a claim of one of the owner's own saved contacts.
const OTHERS = { released: `c.released`, record: RECORD_SHOWN, contact: OWN_CONTACT_CLAIM } as const;
export type SourceOther = keyof typeof OTHERS;

// The left joins `sourceShown(items)` reads, one per item, in the order given.
export const sourceJoins = (items: readonly SourceItem[]): string =>
  items
    .map(
      (item) =>
        `left join ${ITEMS[item].table} ${ITEMS[item].alias} on ${ITEMS[item].alias}.evidence_id = c.evidence_id`,
    )
    .join("\n  ");

const itemShown = (item: SourceItem): string => {
  const { alias, shown } = ITEMS[item];
  return shown === "" ? `${alias}.id is not null` : `(${alias}.id is not null and ${shown})`;
};

// A claim's source is one the token may see: an item of `items` (joined by sourceJoins) it shows,
// or, when the evidence is none of them, one of `others`. A statement names the sources it serves,
// so a new kind of source is one row above and one word in each statement that serves it.
export const sourceShown = (items: readonly SourceItem[], others: readonly SourceOther[]): string =>
  `(${items.map(itemShown).join(" or ")}
      or (${items.map((item) => `${ITEMS[item].alias}.id is null`).join(" and ")} and (${others.map((other) => OTHERS[other]).join(" or ")})))`;

// The same rule with no joins: each item probed by the claim's evidence.
export const sourceProbed = (items: readonly SourceItem[], others: readonly SourceOther[]): string => {
  const probe = (item: SourceItem, shown: boolean): string => {
    const { alias, table } = ITEMS[item];
    const also = shown && ITEMS[item].shown !== "" ? ` and ${ITEMS[item].shown}` : "";
    return `exists (select 1 from ${table} ${alias} where ${alias}.evidence_id = c.evidence_id${also})`;
  };
  return `(
    ${items.map((item) => probe(item, true)).join("\n    or ")}
    or (${items.map((item) => `not ${probe(item, false)}`).join("\n      and ")}
      and (${others.map((other) => OTHERS[other]).join("\n        or ")})))`;
};

// A row (`alias`) within the audience bound at `param`. A client's read binds null, and its token's
// row policies hold; the owner's read, run as pi_admin, binds their audience, which the statement
// then states on every table it reads.
export const inAudience = (alias: string, param: string): string =>
  `(${param}::text[] is null or ${alias}.compartments <@ ${param}::text[])`;

// The owner's own statement of what pi_reader's row policies would hold, for a read run as pi_admin:
// their audience and the people and organizations they withheld (policy.entity_withheld's set).
export type OwnerAudience = { audience: readonly string[]; withheld: ReadonlySet<string> };

// A person or an organization the token shows, by id, never the owner; and those among several ids.
// One fixed statement each, whatever the ids name.
export const PERSON_OR_ORG = `select e.id, e.kind from knowledge.entities e where e.id = $1 and e.kind in ('person', 'organization') order by e.id`;
export const PEOPLE_OR_ORGS = `select e.id, e.kind from knowledge.entities e where e.id = any($1) and e.kind in ('person', 'organization') order by e.id`;
