import {
  BELIEF_TYPES,
  type BeliefLine,
  type BeliefTier,
  type ClaimRecord,
  type EntityId,
  type FactId,
  type FactKeyFp,
  type FactSource,
  KEY_FIELDS,
  type OwnerPageArgs,
  type OwnerSideKind,
  type RulingId,
  SELF_HOUSEKEEPING_LINES,
  SELF_STATUSES,
  type SelfReviewPage,
  type SelfStatus,
} from "@intelligence/contracts/personal";
import { factLine } from "@intelligence/personal-core/checks";
import {
  collapseByGroup,
  noticeLapsed,
  ownStatement,
  proposalLine,
  rankLines,
  useBandOf,
} from "@intelligence/personal-core/views";
import type { AdminContext } from "../../core/admin-context.ts";
import { type Query, stamp } from "../../core/db.ts";
import type { Keys } from "../../core/keys.ts";
import type { Sealed } from "../../core/seal.ts";
import { OWNER_ENTITY } from "../../core/statements.ts";
import { openedUnder } from "../../core/tx.ts";
import { ADMIN_FACT_SOURCE } from "../../read/fact-source.ts";
import { whoOf } from "../../read/read-who.ts";
import { claimRecordUnder, type OwnerPlace, ownerBeliefs, ownerPage, pageOf } from "../admin-owner.ts";
import { ownerCtx } from "../owner-ctx.ts";

// The owner's review of what the store holds about them: `pi self review`. As pi_admin, over every
// compartment: each belief of the owner's audience whose subject is the owner, their commitments
// left out (get_commitments serves them), then each claim about the owner in no such belief, which
// get_self leaves out: from mail that is not bulk, under no reject in force, and of the owner's own
// words only a statement. Each row carries its words, its source and the claim ids the owner gives
// `pi correct reject` (wrong) or `pi self retire` (true but past). It writes nothing. `pi self
// review` prints it whole to a terminal; the dashboard's Self room reads it a page at a time.
//
// The reader's filters it keeps, stated in its SQL: a claim from a held message is left out, as
// get_self leaves it out (`not m.held`). Every claim it lists is from a message, so no release
// arises, and every row is about the owner, so no withheld or ignored person does. Beliefs come
// from `ownerBeliefs`, the owner's audience alone, the one source of the owner's beliefs.

// What a row's status may be: a belief's, `retired` for one closed by a retire in force (its
// belief is `closed`), and `no_belief` for a claim in none. The list is contracts' (the page's
// `SelfReviewRow` carries it).
export { SELF_STATUSES, type SelfStatus };

// `fact` is the latest claim's id; `facts` every claim the row rests on, latest first. `source`
// is where the latest came from, as a FactSource (ADMIN_FACT_SOURCE). `words` is its text, as the source wrote it: untrusted.
export type SelfReviewRow = {
  n: number;
  kind: string;
  status: SelfStatus;
  at: string;
  words: string;
  source: FactSource;
  ownWords: boolean;
  fact: FactId;
  facts: FactId[];
  factKey: FactKeyFp;
  tier: string | null;
  domain: string | null;
  carried: RulingId[];
  // `notice`, an automated notice's standing, null for anything else.
  use: number;
  rank: number;
  notice: "current" | "older" | null;
};

type SelfReviewFilter = { kind?: string; status?: SelfStatus };

// The owner's stated types, as get_self's `stated` had them: no commitment, no project type.
const STATED_TYPES = BELIEF_TYPES.filter((type) => type !== "commitment" && !type.startsWith("project."));

type ClaimRow = {
  id: FactId;
  type: string;
  valid_from: Date;
  fact_key_fp: FactKeyFp;
  content_enc: Sealed;
  compartments: string[];
  source: FactSource;
};

const CLAIM_COLUMNS = `
  select c.id, c.type, c.valid_from, c.fact_key_fp, c.content_enc, c.compartments,
    ${ADMIN_FACT_SOURCE} as source
  from knowledge.claims c
  left join knowledge.messages m on m.evidence_id = c.evidence_id
  left join knowledge.documents d on d.evidence_id = c.evidence_id
  left join knowledge.captures k on k.evidence_id = c.evidence_id`;

// The claims of a stated type in none of `$2` and under no reject in force, by its item and fact
// key, from mail that is not bulk: get_self leaves them out, and only `pi self review` lists them.
// Within `$3`, the compartments this key set opens: pi_admin's policies return every row, and one
// claim under a key the owner's commands are not given, the standing check's or a restricted one,
// would otherwise fail the whole review.
const UNBUILT = `${CLAIM_COLUMNS}
  where c.type = any ($1::text[]) and not (c.id = any ($2::text[])) and m.id is not null and not m.held and m.bulk is not true
    and c.compartments <@ $3::text[]
    and not exists (
      select 1 from vault.evidence_items e join policy.rejected_claims() r
        on r.source_account_id = e.source_account_id and r.source_item_fp = e.source_item_fp
      where e.id = c.evidence_id and r.fact_key_fp in (c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp))
  order by c.valid_from desc, c.id collate "C"`;

const CARRIED = `
  select c.id as claim_id, r.ruling_id
  from knowledge.claims c
  join vault.evidence_items e on e.id = c.evidence_id
  join knowledge.belief_rulings r on r.fact_key_fp in (c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp) and r.fact_key_fp <> c.fact_key_fp and r.lifted_at is null
  where c.id = any ($1::text[])
    and ((r.verdict = 'reject' and r.source_account_id = e.source_account_id and r.source_item_fp = e.source_item_fp)
      or (r.verdict in ('veto', 'retire') and exists (
        select 1 from unnest(r.item_account_ids, r.item_fps) as i (account, item)
        where i.account = e.source_account_id and i.item = e.source_item_fp)))
  order by r.created_at, r.ruling_id collate "C"`;

// A calendar day as words, "1 Mar 2027", as the page writes a day; anything else as it was given.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayWords(value: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const month = day === null ? undefined : MONTHS[Number(day[2]) - 1];
  return day === null || month === undefined ? value : `${Number(day[3])} ${month} ${day[1]}`;
}
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

// A claim's words as one sentence a person reads at once, never its field names: a role or an
// affiliation by the core's line (`factLine`), its organization by the name `organizations` gives
// an entity; an owner-side kind by its key phrase, else its `what`, with a preference's polarity
// before it and a date in words after it; any other kind by its `what`, else its first free text
// with the rest in brackets. Every word but the source's is code's.
export function wordsOf(record: ClaimRecord, organizations: ReadonlyMap<string, string> = new Map()): string {
  const fields = record.claim.content.fields;
  const text = (name: string): string | undefined => {
    const value = fields[name];
    return typeof value === "string" && value.trim() !== "" && record.fieldKinds[name] !== "entity" ? value : undefined;
  };
  const type = record.claim.content.type;
  if (type === "role" || type === "affiliation") {
    const organization =
      text("organization_name") ??
      (typeof fields.organization === "string" ? organizations.get(fields.organization) : undefined);
    const line = factLine(type, {
      ...fields,
      ...(organization === undefined ? {} : { organization_name: organization }),
    });
    if (line.trim() !== "") return line;
  }
  // A view on its topic, where an organization's process stands, and a place the owner has been,
  // each as a sentence.
  const phrase = Object.hasOwn(KEY_FIELDS, type) ? text(KEY_FIELDS[type as OwnerSideKind].phrase) : undefined;
  const dated = (head: string, word: string, name: string): string =>
    text(name) === undefined ? head : `${head}, ${word} ${dayWords(text(name) as string)}`;
  if (type === "view" && phrase !== undefined)
    return text("topic") === undefined ? capital(phrase) : `On ${text("topic") as string}: ${phrase}`;
  if (type === "status" && phrase !== undefined)
    return dated(
      `${text("organization_name") ?? "An organization"}: ${phrase} is ${text("state") ?? "under way"}`,
      "since",
      "since",
    );
  if (type === "visited" && phrase !== undefined) return dated(`Been to ${phrase}`, "on", "when");
  if (Object.hasOwn(KEY_FIELDS, type)) {
    const said = phrase;
    const what = said ?? text("what");
    if (what !== undefined) {
      const polarity = text("polarity");
      // A key phrase is a slice of a sentence; a `what` is the source's whole statement, kept as said.
      const head =
        said === undefined
          ? what
          : type === "preference" && (polarity === "prefers" || polarity === "avoids")
            ? `${capital(polarity)} ${said}`
            : capital(said);
      const by = text("by");
      const until = text("until");
      return [
        head,
        by === undefined ? null : `by ${dayWords(by)}`,
        until === undefined ? null : `until ${dayWords(until)}`,
      ]
        .filter((one) => one !== null)
        .join(", ");
    }
  }
  const what = text("what");
  if (what !== undefined) return what;
  // Any other kind: its words as a sentence, never its values strung with commas: its first free
  // text, capitalised, and the rest after it in brackets, so two claims that differ only there
  // still read apart. A list's value has its underscores as spaces.
  const values = Object.entries(fields).filter(
    ([name, value]) =>
      record.fieldKinds[name] !== "entity" &&
      (typeof value === "string" || typeof value === "number") &&
      String(value).trim() !== "",
  );
  const head =
    values.find(([name]) => record.fieldKinds[name] === "text") ??
    values.find(([, value]) => typeof value === "string") ??
    values[0];
  if (head === undefined) return "";
  const said = ([, value]: [string, unknown]): string => String(value).replaceAll("_", " ").trim();
  const rest = values.filter((one) => one !== head).map(said);
  return `${capital(said(head))}${rest.length === 0 ? "" : ` (${rest.join(", ")})`}`;
}

// The names of the organizations the records name by entity, for a role's or an affiliation's line.
async function organizationsOf(
  admin: AdminContext,
  query: Query,
  records: readonly ClaimRecord[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      records.flatMap((record) => {
        const id = record.claim.content.fields.organization;
        return record.fieldKinds.organization === "entity" && typeof id === "string" ? [id] : [];
      }),
    ),
  ];
  if (ids.length === 0) return new Map();
  const ctx = ownerCtx(query, admin.keys, admin.log);
  const who = await whoOf(ctx, ids);
  return new Map(
    ids.flatMap((id) => {
      const one = who.get(id);
      const name = one?.name?.untrusted ?? one?.address?.untrusted;
      return name === undefined ? [] : [[id, name] as const];
    }),
  );
}

// The row without what the order gives it, as `reviewRanks` takes it.
type Unranked = Omit<SelfReviewRow, "n" | "use" | "rank" | "notice">;
type Ranks = Pick<SelfReviewRow, "use" | "rank" | "notice">;
export type RankedRow = { row: Unranked; record: ClaimRecord; moved: boolean };

// A row as `get_self`'s line, for core's ranking: the kind's template over the claim's own fields, so
// a fragment is told as it is on the page an agent reads. A retire is an ended line; a loose claim
// has no belief to have ended.
function lineOf({ row, record }: RankedRow): BeliefLine {
  const words = Object.hasOwn(KEY_FIELDS, row.kind)
    ? proposalLine(row.kind as OwnerSideKind, record.claim.content.fields)
    : row.words;
  return {
    fact: row.fact,
    kind: row.kind,
    domain: null,
    line: { untrusted: words },
    tier: row.tier,
    status: row.status === "retired" ? "closed" : row.status === "no_belief" ? "active" : row.status,
    since: row.at,
    at: row.at,
    cites: row.facts.length,
    ...(row.tier === "system_notice" ? { notice: { from: null, subject: null, sentAt: row.at } } : {}),
  } as BeliefLine;
}

// A notice is apart from their life unless they moved it to a part of it (invariant 11): the newest
// few not lapsed are current, every other is older, and none is lost.
export function reviewRanks(rows: readonly RankedRow[], now: Date): Map<Unranked, Ranks> {
  const lines = new Map(rows.map((one) => [lineOf(one), one] as const));
  let current = 0;
  const ranks = new Map<Unranked, Ranks>();
  rankLines([...lines.keys()]).forEach((line, index) => {
    const { row, moved } = lines.get(line) as RankedRow;
    const apart = row.tier === "system_notice" && !moved;
    const live = line.status === "active" || line.status === "stale";
    const fresh = apart && live && !noticeLapsed(line, now) && current < SELF_HOUSEKEEPING_LINES;
    if (fresh) current += 1;
    ranks.set(row, { use: useBandOf(line), rank: index + 1, notice: !apart ? null : fresh ? "current" : "older" });
  });
  return ranks;
}

// A row is its latest claim, as every row is, with the set's highest tier. The owner's move of any
// member holds for the row, whichever member is latest (invariant 11): `moved` names those rows by
// their fact, and the row takes that part.
export function joinedBeliefs(
  built: readonly { one: Unranked; group?: string; tier: BeliefTier }[],
  placeOf: (fact: string) => number,
  ruled: ReadonlySet<string>,
): { rows: Unranked[]; moved: ReadonlySet<string> } {
  const moved = new Set<string>();
  const rows = collapseByGroup(built).map((kept): Unranked => {
    const members = kept.group === undefined ? [kept] : built.filter((other) => other.group === kept.group);
    const facts = [...new Set(members.flatMap((other) => other.one.facts))].sort((a, b) => placeOf(a) - placeOf(b));
    const latest = members.find((other) => other.one.fact === facts[0]) ?? kept;
    const placed = members.find((other) => ruled.has(other.one.factKey));
    if (placed !== undefined) moved.add(latest.one.fact);
    return {
      ...latest.one,
      tier: kept.one.tier,
      domain: placed?.one.domain ?? latest.one.domain,
      status: members.some((other) => other.one.status === "retired") ? "retired" : latest.one.status,
      facts,
      carried: [...new Set(members.flatMap((other) => other.one.carried))],
    };
  });
  return { rows, moved };
}

export function selfReview(admin: AdminContext, filter: SelfReviewFilter = {}): Promise<SelfReviewRow[]> {
  return admin.transaction((query) => reviewRows(admin, query, filter));
}

// A row's place in the review's order: beliefs before loose claims, then kind, the latest first,
// then fact.
const placeOf = (row: SelfReviewRow): OwnerPlace => [
  row.tier === null ? 1 : 0,
  row.kind,
  -Date.parse(row.at),
  row.fact,
];
const isPlace = (place: OwnerPlace): boolean =>
  place.length === 4 &&
  (place[0] === 0 || place[0] === 1) &&
  typeof place[1] === "string" &&
  typeof place[2] === "number" &&
  typeof place[3] === "string" &&
  /^[0-9a-f]{64}$/.test(place[3]);

// One page of the review, in its order, each row numbered in the whole list, as the page reads it
// (`SelfReviewPage`): its words inside { untrusted }, and the owner's entity id, which the page asks
// `beliefsAsOf` about. The whole review is computed for each page, as `pi self review` computes
// it; its rows are the owner's own, a few hundred at most.
export async function selfReviewPage(
  admin: AdminContext,
  filter: SelfReviewFilter,
  args: OwnerPageArgs,
): Promise<SelfReviewPage> {
  const page = ownerPage(args, isPlace);
  return admin.transaction(async (query) => {
    const [owner] = await query<{ id: EntityId }>(OWNER_ENTITY);
    const { rows, next } = pageOf(await reviewRows(admin, query, filter), placeOf, page);
    return { owner: owner?.id ?? null, rows: rows.map((row) => ({ ...row, words: { untrusted: row.words } })), next };
  });
}

async function ruledDomainsOf(keys: Keys, query: Query): Promise<Map<string, string>> {
  const rows = await query<{ ruling_id: string; fact_key_fp: string; compartments: string[]; value_enc: Sealed }>(
    "select ruling_id, fact_key_fp, compartments, value_enc from knowledge.belief_rulings where verdict = 'domain' and lifted_at is null",
  );
  return new Map(
    rows.map((row) => [
      row.fact_key_fp,
      openedUnder(
        keys,
        row.compartments,
        { table: "knowledge.belief_rulings", id: row.ruling_id, column: "value_enc" },
        row.value_enc,
      ),
    ]),
  );
}

async function carriedTo(query: Query, ids: readonly string[]): Promise<Map<string, RulingId[]>> {
  const found = new Map<string, RulingId[]>();
  if (ids.length === 0) return found;
  for (const row of await query<{ claim_id: string; ruling_id: RulingId }>(CARRIED, [[...ids]]))
    found.set(row.claim_id, [...(found.get(row.claim_id) ?? []), row.ruling_id]);
  return found;
}
const carriedOf = (carried: Map<string, RulingId[]>, facts: readonly string[]): RulingId[] => [
  ...new Set(facts.flatMap((fact) => carried.get(fact) ?? [])),
];

async function reviewRows(admin: AdminContext, query: Query, filter: SelfReviewFilter): Promise<SelfReviewRow[]> {
  const [owner] = await query<{ id: string }>(OWNER_ENTITY);
  if (owner === undefined) return [];
  const open = (row: ClaimRow): ClaimRecord => claimRecordUnder(admin.keys, row);

  // A belief's `support` holds its claims' stored ids; the sealed belief holds their own.
  // Only the stated types' beliefs: a commitment's or a project's is never a review row.
  const owned = await ownerBeliefs({ query, keys: admin.keys }, { types: STATED_TYPES });
  const ruledDomain = await ruledDomainsOf(admin.keys, query);
  const domainOf = (factKey: string, record: ClaimRecord): string | null => {
    const own = record.claim.content.fields.domain;
    return ruledDomain.get(factKey) ?? (typeof own === "string" ? own : null);
  };
  // The latest retire in force of each fact key. A claim dated after it reopened
  // the belief, which is then shown as it stands.
  const retired = new Map(
    (
      await query<{ fact_key_fp: string; at: Date }>(
        "select fact_key_fp, max(created_at) as at from knowledge.belief_rulings where verdict = 'retire' and lifted_at is null group by fact_key_fp",
      )
    ).map((row) => [row.fact_key_fp, row.at.getTime()]),
  );
  const beliefs = owned.flatMap((row) =>
    row.belief.subject === owner.id && row.belief.kind !== "commitment" ? [{ row, belief: row.belief }] : [],
  );

  const support = [...new Set(beliefs.flatMap(({ row }) => row.support))];
  const supportRows =
    support.length === 0
      ? []
      : await query<ClaimRow>(
          `${CLAIM_COLUMNS} where c.id = any ($1::text[]) order by c.valid_from desc, c.id collate "C"`,
          [support],
        );
  const place = new Map(supportRows.map((row, index) => [row.id as string, index]));

  const unbuilt = await query<ClaimRow>(UNBUILT, [[...STATED_TYPES], support, [...admin.keys.compartments.keys()]]);
  const carried = await carriedTo(query, [...support, ...unbuilt.map((row) => row.id)]);

  type Row = Unranked;
  // Each row's record, whose words are written once the organizations they name are read.
  const opened = new Map<string, ClaimRecord>();
  const built: { one: Row; group?: string; tier: BeliefTier }[] = [];
  for (const { row, belief } of beliefs) {
    const facts = row.support
      .filter((id) => place.has(id))
      .sort((a, b) => (place.get(a) as number) - (place.get(b) as number)) as FactId[];
    const latest = supportRows[place.get(facts[0] ?? "") ?? -1];
    if (latest === undefined) continue;
    const record = open(latest);
    const one: Row = {
      kind: belief.kind,
      status: retired.has(row.factKey) && belief.status === "closed" ? "retired" : belief.status,
      at: belief.lastConfirmedAt,
      words: "",
      source: latest.source,
      ownWords: record.origin !== "agent_record" && ownStatement(record.claim, record.claim.assertedBy === owner.id),
      fact: latest.id,
      facts,
      factKey: row.factKey as FactKeyFp,
      tier: row.tier,
      domain: domainOf(row.factKey, record),
      carried: carriedOf(carried, facts),
    };
    opened.set(one.fact, record);
    built.push({ one, tier: row.tier as BeliefTier, ...(row.group === null ? {} : { group: row.group }) });
  }
  // A retire of any member closes it.
  const joined = joinedBeliefs(built, (fact) => place.get(fact) as number, new Set(ruledDomain.keys()));
  const beliefRows = joined.rows;

  // The claims about the owner in none of their beliefs, as get_self lists them.
  const loose: Row[] = [];
  const looseOf = new Map<string, Row>();
  for (const row of unbuilt) {
    const record = open(row);
    if (record.subjectKind !== "owner" || record.claim.content.subject !== owner.id) continue;
    // As get_self: of the owner's own words, only a statement.
    const own = ownStatement(record.claim, record.claim.assertedBy === owner.id);
    if (record.claim.basis === "explicit_self" && !own) continue;
    // Latest first, so the row reads as its latest claim and rests on them all.
    const said = looseOf.get(row.fact_key_fp);
    if (said !== undefined) {
      said.facts.push(row.id);
      said.carried = [...new Set([...said.carried, ...carriedOf(carried, [row.id])])];
      continue;
    }
    const one: Row = {
      kind: row.type,
      // A claim said before a retire in force of its fact key is retired, even before the next
      // rebuild closes the belief.
      status: row.valid_from.getTime() <= (retired.get(row.fact_key_fp) ?? -Infinity) ? "retired" : "no_belief",
      at: stamp(row.valid_from),
      words: "",
      source: row.source,
      ownWords: own,
      fact: row.id,
      facts: [row.id],
      factKey: row.fact_key_fp,
      tier: null,
      domain: domainOf(row.fact_key_fp, record),
      carried: carriedOf(carried, [row.id]),
    };
    opened.set(one.fact, record);
    loose.push(one);
    looseOf.set(row.fact_key_fp, one);
  }
  const organizations = await organizationsOf(admin, query, [...opened.values()]);
  for (const one of [...beliefRows, ...loose]) one.words = wordsOf(opened.get(one.fact) as ClaimRecord, organizations);

  const kept = (one: Row): boolean =>
    (filter.kind === undefined || one.kind === filter.kind) &&
    (filter.status === undefined || one.status === filter.status);
  const order = (a: Row, b: Row): number =>
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
    Date.parse(b.at) - Date.parse(a.at) ||
    (a.fact < b.fact ? -1 : a.fact > b.fact ? 1 : 0);
  const rows = [...beliefRows.filter(kept).sort(order), ...loose.filter(kept).sort(order)];
  const ranks = reviewRanks(
    rows.map((row) => ({
      row,
      record: opened.get(row.fact) as ClaimRecord,
      moved: joined.moved.has(row.fact) || ruledDomain.has(row.factKey),
    })),
    admin.now(),
  );
  return rows.map((one, index) => ({ n: index + 1, ...one, ...(ranks.get(one) as Ranks) }));
}
