// find_facts' fixed statements, the rows they return and how a sealed value of one is opened, which
// the fact reads and the compiled reads both build on.

import {
  ACTIVITY_FACT_TYPES,
  type CaptureId,
  ClaimRecord,
  type DocumentId,
  type EntityId,
  type FactView,
  KEY_FIELDS,
  type MessageId,
  type OwnerSideKind,
  type PageId,
  type Who,
} from "@intelligence/contracts/personal";
import { maskCredentials } from "@intelligence/personal-core";
import { TITLE_LINK_TYPE } from "../core/link-types.ts";
import { type Ctx, epochSeconds } from "../core/read-ctx.ts";
import type { Sealed } from "../core/seal.ts";
import { parseOr, served, servedJson } from "../core/served.ts";
import { OWN_CONTACT_CLAIM, OWNER_ENTITY_ALIASED } from "../core/statements.ts";
import { NAMES_SHOWN, RELEASE_IN_FORCE, recordOf, sourceJoins, sourceProbed, sourceShown } from "../core/visibility.ts";

// find_facts' fixed queries. Every statement runs under the caller's token, so the order, the limit and `more` are over the rows it returned.
// The statements are the same whatever the page holds: the claims with their messages, the
// people they name and the beliefs of their fact keys are each one statement over the page.

// The types whose `until` is also served as the fact's validTo.
const UNTIL_TYPES: ReadonlySet<string> = new Set(["constraint", "situation", "contact_rule"]);
// The types whose claim's validTo a fact serves: those with an `until`,
// and the owner's activity facts, whose validTo is the end of what they observed.
export const VALID_TO_TYPES: ReadonlySet<string> = new Set([...UNTIL_TYPES, ...ACTIVITY_FACT_TYPES]);

// A claim's text as served: credential-shaped values masked, keeping
// its length, whatever its source and whenever it was stored. The stored claim is unchanged.
export const servedText = (value: string): string => maskCredentials(value).text;

// A time is bound as seconds since the epoch, never as text, as the timeline binds it.
export const seconds = (at: string | undefined): number | null => (at === undefined ? null : epochSeconds(at));

// Never the owner: asking for the owner's id is as asking for one that is not there.
export const ENTITY = `
  select e.id from knowledge.entities e
  where e.id = $1 and e.kind in ('person', 'organization')
  order by e.id`;

// What find_facts' entity takes: those, or a project the token shows, whose findings name it.
export const FACT_ENTITY = `
  select e.id from knowledge.entities e
  where e.id = $1 and e.kind in ('person', 'organization', 'project')
  order by e.id`;

// Each claim with its message's row, or with its document's, never a held one (the row policy
// hides it as well), or a finding's claim: one whose evidence is an agent record's that the
// caller's token returns from ledger.agent_writes, whose row policy holds the record's whole
// label, its writer's views and its flag. The test is that row, never a missing message row nor an
// `agent:` compartment alone. Newest first by the claim's time, then by id, one more than asked
// so `more` is known.
// A type matches itself and its children. A claim that names a person, an organization or a
// project the token does not show is not returned: whether it is depends only on rows the
// token sees.
// Every match is found first, by the indexes led by the label key, and only then ordered and
// cut: a cut in the same select as the claims would let the planner
// walk the claims of every compartment by type and time. The records and the people named are
// each read once, as sets; each person named is looked up by its id. The matches are kept by
// id and time alone; only the page's claims are read whole, by their ids.

// A claim's source is one the token may see (above): a message or document not held, a page, a
// capture item, a finding's record the token returns, or one of the owner's own contacts.
const FACT_ITEMS = ["message", "document", "page", "capture"] as const;
const SOURCE_SHOWN = sourceShown(FACT_ITEMS, ["released", "record", "contact"]);

// A fact find_facts would return rests on the agent record `w`: a claim of the record's evidence,
// by find_facts' terms, each source probed by the claim's evidence. Only claims the caller's token
// returns are asked of, so a hidden claim answers as a missing one (invariant 6).
export const FACT_RESTS_ON_RECORD = `exists (
      select 1 from knowledge.claims c
      where c.evidence_id = w.evidence_id
        and ${sourceProbed(FACT_ITEMS, ["released", "record", "contact"])}
        and c.type <> '${TITLE_LINK_TYPE}'
        and ${RELEASE_IN_FORCE}
        and ${NAMES_SHOWN})`;

// Or a contact's, one of the owner's own (`own`) saved contacts the token returns, the claims
// code makes from it, as detailsOf serves its fields.
// Or a page's, its row read under the token, within the clearance.
// Or a capture item's, its knowledge.captures row read under the token,
// within the clearance, so a client sees the fact only when it sees the row; with the row's
// `agent_app`, which serves its claim as an agent's.
// The order ends with the joined page's id: it breaks no tie, since the terms
// before it are already a key of the rows, but it names the key of every relation joined.
// The fact rows of the claims `where` picks, newest first, at most `limit` (a bind parameter).
const factRowsSql = (where: string, limit: string): string => `
  with found as materialized (
    select c.id, c.valid_from, m.id as message_id, d.id as document_id, g.id as page_id, k.id as capture_id, k.agent_app as capture_agent_app, k.kind as capture_kind, k.source as capture_source
    from knowledge.claims c
    ${sourceJoins(FACT_ITEMS)}
    where ${where}
  )
  select c.id, c.type, c.valid_from, c.fact_key_fp, c.content_enc, c.compartments, p.message_id, p.document_id,
    p.page_id, g.page_enc, g.fetched_at, g.compartments as page_compartments, c.evidence_id, p.capture_id, p.capture_agent_app, p.capture_kind, p.capture_source,
    ${recordOf("p.message_id is null and p.document_id is null and p.page_id is null and p.capture_id is null")},
    (p.message_id is null and p.document_id is null and p.page_id is null and p.capture_id is null
      and ${OWN_CONTACT_CLAIM}) as contact
  from (select found.id, found.message_id, found.document_id, found.page_id, found.capture_id, found.capture_agent_app, found.capture_kind, found.capture_source from found
        order by found.valid_from desc, found.id, found.message_id, found.document_id, found.page_id, found.capture_id limit ${limit}) p
  join knowledge.claims c on c.id = p.id
  left join knowledge.pages g on g.id = p.page_id
  order by c.valid_from desc, c.id, p.message_id, p.document_id, p.page_id, p.capture_id, g.id`;

// `more`: a further term on the claims found. With none, the text is find_facts' own.
const findFactsSql = (more = ""): string =>
  factRowsSql(
    `${SOURCE_SHOWN}
      and ($1::text is null or c.type = $1 or starts_with(c.type, $1 || '.'))${more}
      and c.type <> '${TITLE_LINK_TYPE}'
      and ${RELEASE_IN_FORCE}
      and ($2::text[] is null or c.id in (select n.claim_id from knowledge.claim_entities n where n.entity_id = any($2::text[])))
      and ($3::float8 is null or c.valid_from >= to_timestamp($3))
      and ($4::float8 is null or c.valid_from <= to_timestamp($4))
      and ${NAMES_SHOWN}`,
    "$5",
  );
export const FIND_FACTS = findFactsSql();
// The same, of the claims no agent record carries: what the owner and the sources said. An
// agent's words, however many, take none of its rows (read-project-status.ts).
export const FIND_FACTS_UNRECORDED = findFactsSql(`
      and not exists (select 1 from ledger.agent_writes w where w.evidence_id = c.evidence_id)`);

// Each claim of a belief's support (`$1`) that FIND_FACTS would return, by the same terms, at most `$2`.
export const BELIEF_FACTS = factRowsSql(
  `c.id = any($1::text[])
      and ${SOURCE_SHOWN}
      and c.type <> '${TITLE_LINK_TYPE}'
      and ${RELEASE_IN_FORCE}
      and ${NAMES_SHOWN}`,
  "$2",
);

// The projects the given claims name, as the token shows them, each as its Who: whoOf reads
// people and organizations alone. One statement, whatever the claims name.
export const PROJECTS_NAMED = `
  select p.id, p.compartments, p.name_enc
  from knowledge.projects p
  where p.id in (select n.entity_id from knowledge.claim_entities n where n.claim_id = any($1))
  order by p.id`;

// The same, of the given project ids.
export const PROJECTS = `
  select p.id, p.compartments, p.name_enc
  from knowledge.projects p
  where p.id = any($1)
  order by p.id`;

// A project row of those statements as a Who, its name opened.
export const projectRowWho = (ctx: Ctx, row: { id: string; compartments: string[]; name_enc: Sealed }): Who => ({
  id: row.id as EntityId,
  kind: "project",
  name: served(ctx, row, "knowledge.projects.name_enc"),
  address: null,
});

// The declassified copies that match the type and time filters, for a client
// cleared for `declassified` and given no entity filter. Newest first, then by claim id, the
// order of the claims (`id` breaks no tie: `claim_fp` is unique), one more than asked. A copy
// whose claim FIND_FACTS returned is left out in code, so the fact is returned once, as the claim; a
// claim FIND_FACTS leaves out (its message held, or naming someone the token does not show) leaves
// its copy in, as for a client cleared for `declassified` alone. Every copy holds the one label
// `declassified`, so the key-led index walks only visible rows.
export const DECLASSIFIED_FACTS = `
  select d.id, d.claim_fp, d.evidence_id, d.valid_from, d.fact_enc, d.compartments
  from projections.declassified_facts d
  where ($1::text is null or d.type = $1 or starts_with(d.type, $1 || '.'))
    and ($2::float8 is null or d.valid_from >= to_timestamp($2))
    and ($3::float8 is null or d.valid_from <= to_timestamp($3))
  order by d.valid_from desc, d.claim_fp, d.id
  limit $4`;

// The owner's visible account with the lowest id: the owner's id and address. The owner by the
// owner's index, its accounts by its id, every one of them before the cut.
export const OWNER = `
  with mine as materialized (
    select a.entity_id, a.id, a.compartments, a.value_enc
    from knowledge.accounts a
    where a.entity_id = (${OWNER_ENTITY_ALIASED})
  )
  select mine.* from mine
  order by mine.id
  limit 1`;

export type FactRow = {
  id: string;
  type: FactView["type"];
  valid_from: Date;
  fact_key_fp: string;
  content_enc: Sealed;
  compartments: string[];
  // Null for a finding's claim, which has no message, and for a document's.
  message_id: MessageId | null;
  document_id: DocumentId | null;
  // A page's claim's page, its sealed URL and when it was fetched;
  // absent where a statement reads no page (get_entity's compiled facts).
  page_id?: PageId | null;
  page_enc?: Sealed | null;
  fetched_at?: Date | null;
  page_compartments?: string[] | null;
  evidence_id: string;
  // A finding's agent record, as the token returns it; absent where a statement reads none.
  record_id?: string | null;
  // That record's writing client, read from the same row; absent where a statement reads none.
  record_client?: string | null;
  // A capture item's claim's knowledge.captures row, as the token returns it; absent where a
  // statement reads none.
  capture_id?: CaptureId | null;
  // Whether that row is an agent app's moment; absent where a statement reads none.
  capture_agent_app?: boolean | null;
  // FactSource: that row's kind and its source (a source moment's, iMessage); absent where a
  // statement reads none.
  capture_kind?: string | null;
  capture_source?: string | null;
  // A claim code made from one of the owner's own contacts; absent where a statement reads none.
  contact?: boolean;
  // A compiled read's marks of a document's or a page's claim, which it serves with neither id
  // (noDocument); absent where a statement reads none.
  document?: boolean;
  from_page?: boolean;
};

// Whether a served fact binds its evidence in the read log: a message's, a page's, a capture
// item's and an own contact's do,
// so deleting the item reaches what was written after the read. A finding's words are an agent
// record's and are shown by the record's id; a document's fact binds nothing.
export const binds = (row: FactRow): boolean =>
  row.message_id !== null ||
  (row.page_id ?? null) !== null ||
  (row.capture_id ?? null) !== null ||
  row.contact === true;

// The name a claim's field is served by: an owner-side kind's key
// phrase (`object`, `objective`, `rule` or `state`) as `what`, every other as it is stored.
// `pi facts show` and a declassification serve it so too (renderFact).
export const servedField = (type: string, field: string): string =>
  Object.hasOwn(KEY_FIELDS, type) && KEY_FIELDS[type as OwnerSideKind].phrase === field ? "what" : field;

// The passage a document's claim cites, as offsets into get_document's text. A span that is
// not of that form names no passage.
const SPAN = /^chars:(\d{1,9})-(\d{1,9})$/;
export const passageOf = (span: string | undefined): { start: number; end: number } | null => {
  const match = SPAN.exec(span ?? "");
  return match === null ? null : { start: Number(match[1]), end: Number(match[2]) };
};
export type CopyRow = {
  id: string;
  claim_fp: string;
  evidence_id: string;
  valid_from: Date;
  fact_enc: Sealed;
  compartments: string[];
};
export type BeliefRow = {
  id: string;
  fact_key_fp: string;
  support: string[];
  belief_enc: Sealed;
  compartments: string[];
};

// What the call read, for the read log: each fact's message is text it was given by id.
export type FactsRead = { bound: string[]; shown: string[]; factKeyFps: string[] };

// A claim's record, opened and parsed. One that does not parse is a stored value that does not open.
export const claimRecordOf = (
  ctx: Ctx,
  row: { id: string; compartments: string[]; content_enc: Sealed },
): ClaimRecord => parseOr(ClaimRecord.safeParse(servedJson(ctx, row, "knowledge.claims.content_enc")));
