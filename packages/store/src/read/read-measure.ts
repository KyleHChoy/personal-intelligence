import {
  BELIEF_TYPES,
  ClaimRecord,
  type EntityId,
  type PersonalLogger,
  type PersonalView,
} from "@intelligence/contracts/personal";
import { beliefAt } from "@intelligence/personal-beliefs";
import type pg from "pg";
import { endOwnPool, inTransaction, ownPool, type Query } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { open, type Sealed } from "../core/seal.ts";
import { clientKeys } from "../core/served.ts";
import { type StatementTimer, statementTimer } from "../core/statement-timer.ts";
import { NOT_CANARY_SQL } from "../core/statements.ts";
import { readBeliefInputs } from "../pipeline/belief-inputs.ts";
import { everyBelief } from "./computed-beliefs.ts";
import { GET_ENTITY_AREAS, readAbout } from "./read-about.ts";
import { getCard, readCard } from "./read-card.ts";
import { SET_TOKEN } from "./read-db.ts";
import { FIND_FACTS } from "./read-fact-rows.ts";
import { RULINGS } from "./read-groups.ts";
import { findPaths } from "./read-paths.ts";
import { CANDIDATE_NAMES, search } from "./read-tools.ts";
import { getSelf } from "./read-tools-self.ts";

// Measurements taken on the box to set query-time deadlines, sample rate and normalization.
// Each runs in one read-only transaction, so the
// server itself refuses any write; each returns counts and milliseconds only, never a value, a
// name or an id of the owner's data.

// One read-only snapshot: a write in it fails with SQLSTATE 25006 and nothing commits.
const READ_ONLY = { begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", commit: "COMMIT", rollback: "ROLLBACK" };

type Percentiles = { count: number; p50: number; p95: number; p99: number };

export function percentiles(samples: readonly number[]): Percentiles {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number =>
    Math.round((sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0) * 100) / 100;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

const timed = async <T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> => {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
};

type BeliefsMeasure = {
  // get_entity's current read path (the card), for the subjects with the most claims.
  getEntity: Percentiles & { subjects: number; notFound: number };
  // `beliefAt` over every fact key the client can see, under its clearance, the audience a read
  // computes for: each key alone (its inputs read through policy.belief_inputs
  // and computed), then every key at once in reads of BELIEF_INPUTS_MAX keys. The reader cannot
  // execute policy.audiences(), so each audience is measured under a token of its own; the
  // owner's, under the owner's. `rows` counts the beliefs computed at once.
  beliefsFor: { audienceCompartments: number; keys: number; rows: number; perKey: Percentiles; allMs: number };
};

// policy.belief_inputs takes at most this many keys in one call.
const BELIEF_INPUTS_MAX = 1000;
// The fact keys of the claims the caller can see, of the types that build a belief.
const VISIBLE_KEYS = "select distinct fact_key_fp from knowledge.claims where type = any ($1::text[]) order by 1";

type DisputesMeasure = {
  // The audience measured: the largest one stored, the owner's, by its compartment count.
  audienceCompartments: number;
  beliefs: number;
  disputedByKind: Record<string, number>;
  // Disputed beliefs whose sides are equal once lower-cased and stripped of punctuation.
  wordingOnlyByKind: Record<string, number>;
};

type ProjectsMeasure = {
  // The live projects with at least one anchored item.
  projects: number;
  // The project with the most anchored items: its items, the claims they hold, and the time to
  // compute its links from its anchors.
  items: number;
  claims: number;
  runs: number;
  ms: Percentiles;
};

// `about` for the subjects with the most claims, with every area and with get_entity's
// (GET_ENTITY_AREAS), each against its deadline: `about`'s own 1 500 ms and get_entity's 800 ms,
// which a narrowed call must meet before get_entity can be rendered from it. `refused`: a
// subject the client's clearance does not resolve.
const ABOUT_DEADLINE_MS = 1_500;
const GET_ENTITY_DEADLINE_MS = 800;
type AboutMeasure = {
  subjects: number;
  refused: number;
  all: Percentiles & { overDeadline: number };
  getEntityAreas: Percentiles & { overDeadline: number };
};

// Read performance (`pia extract measure-reads`): one tool's read path, called `n` times: the
// 50th and 95th percentiles and the longest call, the ten statements that took the most time in
// all (each by its id and first words, with its count and its 95th percentile), and the time no
// statement took (decryption, beliefs computed in memory, matching, ranking), in all.
export type ReadMeasure = {
  n: number;
  p50: number;
  p95: number;
  max: number;
  statements: { id: string; words: string; calls: number; totalMs: number; p95Ms: number }[];
  otherMs: number;
};
// A walk reads the whole audience's hops, so a few subjects say what each one costs.
const PATH_SUBJECTS = 5;
type ReadsMeasure = {
  tools: { get_entity: ReadMeasure; get_self: ReadMeasure; search: ReadMeasure; find_paths: ReadMeasure };
  subjects: number;
  plans?: { rulings: unknown; facts: unknown; names: unknown; keys: KeysMeasure };
};
// Read performance: what the row policies' key list costs. Every policy tests a row's label
// key against policy.clearance_keys(), once for each table a statement reads (about 1.2 ms and 572
// buffers a call on the box); client_clearance() and current_client_kind() are the two calls it
// makes. Counts and plans alone: how many keys the token holds, and how many compartments they
// span, never which.
type KeysMeasure = {
  keys: number;
  compartments: number;
  labels: LabelsTable | null;
  plans: { clearanceKeys: unknown; clientClearance: unknown; clientKind: unknown };
};

// Read performance (`--explain`): the identity rulings' statement, the one get_entity still
// waits on, as Postgres plans and runs it under the client's token: `EXPLAIN (ANALYZE, BUFFERS,
// FORMAT JSON)`. A plan holds node kinds, table and index names, the policies' expressions (code),
// row counts and times; the statement takes no value. A plan that held the token's text would be
// withheld, though none can: the token is a setting the policies call a function to read.
const EXPLAIN_RULINGS = `explain (analyze, buffers, format json) ${RULINGS}`;
// And find_facts' statement as whoOf sends it for an organization's name (organizationNamesOf),
// about four times a get_entity: the role claims of the visible organization with the most
// claims, the most a card reads. Its plan holds that organization's id, never its name; null
// when no organization is visible.
const EXPLAIN_FACTS = `explain (analyze, buffers, format json) ${FIND_FACTS}`;
// Search's candidate names: the statement most of a search's time is spent in.
const EXPLAIN_NAMES = `explain (analyze, buffers, format json) ${CANDIDATE_NAMES}`;
const TOP_ORGANIZATION = `
  select ce.entity_id from knowledge.claim_entities ce
  join knowledge.entities e on e.id = ce.entity_id and e.kind = 'organization'
  group by ce.entity_id order by count(*) desc, ce.entity_id limit 1`;
const ORGANIZATION_CLAIMS = 20;
const KEY_COUNTS = `
  select cardinality(k.keys) as keys,
    (select count(distinct one)::int from unnest(k.keys) as key, unnest(string_to_array(key, '|')) as one) as compartments
  from (select policy.clearance_keys() as keys) k`;
// policy.labels' size from the catalog and the statistics views, which any role reads: its pages
// and rows, live and dead, and when it was last vacuumed. Counts only; no role here reads the table.
type LabelsTable = { pages: number; rows: number; live: number; dead: number; vacuumedAt: string | null };
const LABELS_TABLE = `
  select c.relpages::int as pages, c.reltuples::bigint::int as rows, s.n_live_tup::int as live, s.n_dead_tup::int as dead,
    greatest(s.last_vacuum, s.last_autovacuum) as vacuumed_at
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  left join pg_stat_all_tables s on s.relid = c.oid
  where n.nspname = 'policy' and c.relname = 'labels'`;
const EXPLAIN_CALL = (call: string): string => `explain (analyze, buffers, format json) select ${call}`;

// search takes a query's text, never an id: these, in turn, one a call. Words of code, never read
// from the owner's data, so the measure sends nothing of the owner's to the matcher.
const SEARCH_WORDS = [
  "meeting",
  "project",
  "call",
  "intro",
  "plan",
  "dinner",
  "offer",
  "thanks",
  "update",
  "trip",
] as const;
const SELF_RUNS = 10;
const TOP_STATEMENTS = 10;

const ms2 = (ms: number): number => Math.round(ms * 100) / 100;

export function readMeasureOf(timer: StatementTimer): ReadMeasure {
  const { p50, p95 } = percentiles(timer.calls);
  const statements = [...timer.statements.entries()]
    .map(([id, { words, ms }]) => ({
      id,
      words,
      calls: ms.length,
      totalMs: ms.reduce((sum, one) => sum + one, 0),
      p95Ms: percentiles(ms).p95,
    }))
    .sort((a, b) => b.totalMs - a.totalMs || (a.id < b.id ? -1 : 1))
    .slice(0, TOP_STATEMENTS)
    .map((one) => ({ ...one, totalMs: ms2(one.totalMs) }));
  return {
    n: timer.calls.length,
    p50,
    p95,
    max: ms2(Math.max(0, ...timer.calls)),
    statements,
    otherMs: ms2(timer.other.reduce((sum, one) => sum + one, 0)),
  };
}

export type Measure = {
  // As pi_reader, under a client's token: `unauthorized` for a token with no current client.
  beliefs(token: string, options?: { subjects?: number; now?: Date }): Promise<BeliefsMeasure | "unauthorized">;
  about(token: string, options?: { subjects?: number; now?: Date }): Promise<AboutMeasure | "unauthorized">;
  reads(
    token: string,
    options?: { subjects?: number; now?: Date; explain?: boolean },
  ): Promise<ReadsMeasure | "unauthorized">;
  // As pi_pipeline, the two below.
  disputes(): Promise<DisputesMeasure>;
  projects(options?: { runs?: number }): Promise<ProjectsMeasure>;
  close(): Promise<void>;
};

const unavailable = (): Error => new Unavailable();

// The subjects with the most claims, most first.
const TOP_SUBJECTS = `
  select ce.entity_id from knowledge.claim_entities ce
  group by ce.entity_id order by count(*) desc, ce.entity_id limit $1`;

// The owner's audience: every compartment of the claims of a belief type, the canary's left out.
const OWNER_AUDIENCE = `
  select coalesce(array_agg(distinct x order by x), '{}') as audience
  from knowledge.claims c cross join unnest(c.compartments) as x
  where c.type = any ($1::text[]) and ${NOT_CANARY_SQL}`;

// A project's links, computed from its anchors: the messages on its anchored threads and the
// claims they hold, computed at read in place of stored bindings.
const PROJECT_LINKS = `
  select m.evidence_id, c.id as claim_id
  from knowledge.project_anchors a
  join knowledge.messages m on m.thread_fp = a.anchor_fp
  left join knowledge.claims c on c.evidence_id = m.evidence_id
  where a.project_id = $1 and a.kind = 'email_thread' and a.lifted_at is null`;

const PROJECT_SIZES = `
  select a.project_id, count(distinct m.evidence_id)::int as items
  from knowledge.project_anchors a
  join knowledge.messages m on m.thread_fp = a.anchor_fp
  where a.kind = 'email_thread' and a.lifted_at is null
  group by a.project_id order by items desc, a.project_id`;

// A side's value as the equality check compares it, and as it would after normalizing wording.
const sideOf = (fields: Record<string, unknown>): string =>
  JSON.stringify(
    Object.keys(fields)
      .sort()
      .map((key) => [key, fields[key]]),
  );
const wording = (side: string): string => side.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");

// The handles every measurement works with: the key file and the logger.
type Own = Readonly<{ keys: Keys; log: PersonalLogger }>;

export function createMeasure({ url, keys, log }: { url: string; keys: Keys; log: PersonalLogger }): Measure {
  const pool: pg.Pool = ownPool(url, 1, log);
  const read = <T>(fn: (query: Query) => Promise<T>): Promise<T> =>
    inTransaction(pool, READ_ONLY, unavailable, (query) => fn(query));
  const own: Own = { keys, log };
  return {
    about: (token, options) => read((query) => measureAbout(own, query, token, options)),
    reads: (token, options) => read((query) => measureReads(own, query, token, options)),
    beliefs: (token, options) => read((query) => measureBeliefs(own, query, token, options)),
    disputes: () => read((query) => measureDisputes(own, query)),
    projects: (options) => read((query) => measureProjects(query, options)),
    close: () => endOwnPool(pool),
  };
}

// A client's call context with the keys of its compartments alone. No call or read is logged, and
// nothing opens a session: a read that asked for one would be a write.
const clientCtx = ({ keys, log }: Own, query: Query, compartments: readonly string[]): Ctx => ({
  run: query as Ctx["run"],
  keys: clientKeys(keys, compartments),
  log,
  session: () => Promise.reject(new Unavailable()),
  served: { shown: new Set(), factKeyFps: new Set() },
});

// As the reader serves a client: under its token, so row security holds the read to the client's
// clearance. Null for a token with no current client.
async function asClient(
  own: Own,
  query: Query,
  token: string,
): Promise<{ ctx: Ctx; compartments: string[]; views: PersonalView[]; tools: string[] } | null> {
  await query(SET_TOKEN, [token]);
  const [client] = await query<{ compartments: string[]; views: PersonalView[]; tools: string[] }>(
    "select compartments, views, tools from policy.current_client()",
  );
  if (client === undefined) return null;
  return { ctx: clientCtx(own, query, client.compartments), ...client };
}

async function measureAbout(
  own: Own,
  query: Query,
  token: string,
  { subjects = 50, now = new Date() }: { subjects?: number; now?: Date } = {},
): Promise<AboutMeasure | "unauthorized"> {
  const client = await asClient(own, query, token);
  if (client === null) return "unauthorized";
  const top = await query<{ entity_id: EntityId }>(TOP_SUBJECTS, [subjects]);
  const all: number[] = [];
  const narrow: number[] = [];
  let refused = 0;
  for (const { entity_id } of top) {
    const subject = { id: entity_id };
    const whole = await timed(() => readAbout(client.ctx, { subject }, client.compartments, now));
    all.push(whole.ms);
    if (typeof whole.value === "string") refused += 1;
    const areas = [...GET_ENTITY_AREAS];
    narrow.push((await timed(() => readAbout(client.ctx, { subject, areas }, client.compartments, now))).ms);
  }
  const over = (samples: number[], deadline: number): number => samples.filter((ms) => ms > deadline).length;
  return {
    subjects: top.length,
    refused,
    all: { ...percentiles(all), overDeadline: over(all, ABOUT_DEADLINE_MS) },
    getEntityAreas: { ...percentiles(narrow), overDeadline: over(narrow, GET_ENTITY_DEADLINE_MS) },
  };
}

// Each tool's work function, as the Reader's #read runs it, but not through #read: #read alone
// writes the call log (policy.log_call), the read log (policy.log_read) and the session a read log
// row needs, and a read path itself writes nothing. So nothing here asks for a write, and the
// transaction is READ ONLY besides: one would fail with SQLSTATE 25006 and roll back, never commit.
// Not timed, so: #read's token and client statements, its read budget check, and those two log
// writes. Each tool's calls run on a timed query of their own, each call with a fresh `served`, as
// a call of its own would have.
async function measureReads(
  own: Own,
  query: Query,
  token: string,
  { subjects = 50, now = new Date(), explain = false }: { subjects?: number; now?: Date; explain?: boolean } = {},
): Promise<ReadsMeasure | "unauthorized"> {
  const client = await asClient(own, query, token);
  if (client === null) return "unauthorized";
  const top = await query<{ entity_id: EntityId }>(TOP_SUBJECTS, [subjects]);
  const tools = {
    get_entity: statementTimer(query),
    get_self: statementTimer(query),
    search: statementTimer(query),
    find_paths: statementTimer(query),
  };
  const ctxOf = (timer: StatementTimer): Ctx => ({
    ...client.ctx,
    run: timer.run as Ctx["run"],
    served: { shown: new Set(), factKeyFps: new Set() },
    groups: {},
  });
  for (const { entity_id } of top)
    await tools.get_entity.call(() =>
      getCard(ctxOf(tools.get_entity), { id: entity_id }, now, client.views, client.tools),
    );
  for (let run = 0; run < SELF_RUNS; run += 1)
    await tools.get_self.call(() => getSelf(ctxOf(tools.get_self), now, {}, client.views, client.tools));
  for (let n = 0; n < top.length; n += 1)
    await tools.search.call(() =>
      search(ctxOf(tools.search), { query: SEARCH_WORDS[n % SEARCH_WORDS.length] as string }, client.views),
    );
  for (const { entity_id } of top.slice(0, PATH_SUBJECTS))
    await tools.find_paths.call(() => findPaths(ctxOf(tools.find_paths), { target: entity_id }, now));
  const measured: ReadsMeasure = {
    tools: {
      get_entity: readMeasureOf(tools.get_entity),
      get_self: readMeasureOf(tools.get_self),
      search: readMeasureOf(tools.search),
      find_paths: readMeasureOf(tools.find_paths),
    },
    subjects: top.length,
  };
  return explain ? { ...measured, plans: await plansOf(query, token) } : measured;
}

// `--explain`: the plans of the rulings, find_facts' and the names statements, and what the row
// policies' key list costs. A plan that held the token's text is withheld.
async function plansOf(query: Query, token: string): Promise<NonNullable<ReadsMeasure["plans"]>> {
  const planOf = async (statement: string, values?: unknown[]): Promise<unknown> => {
    const [planned] = await query<{ "QUERY PLAN": unknown }>(statement, values);
    const plan = planned?.["QUERY PLAN"] ?? null;
    return token !== "" && JSON.stringify(plan).includes(token) ? "withheld" : plan;
  };
  const [organization] = await query<{ entity_id: string }>(TOP_ORGANIZATION);
  const facts =
    organization === undefined
      ? null
      : await planOf(EXPLAIN_FACTS, ["role", [organization.entity_id], null, null, ORGANIZATION_CLAIMS]);
  const [counted] = await query<{ keys: number; compartments: number }>(KEY_COUNTS);
  const [table] = await query<{ pages: number; rows: number; live: number; dead: number; vacuumed_at: Date | null }>(
    LABELS_TABLE,
  );
  const keys: KeysMeasure = {
    keys: counted?.keys ?? 0,
    compartments: counted?.compartments ?? 0,
    labels:
      table === undefined
        ? null
        : {
            pages: table.pages,
            rows: table.rows,
            live: table.live,
            dead: table.dead,
            vacuumedAt: table.vacuumed_at?.toISOString() ?? null,
          },
    plans: {
      clearanceKeys: await planOf(EXPLAIN_CALL("policy.clearance_keys()")),
      clientClearance: await planOf(EXPLAIN_CALL("policy.client_clearance()")),
      clientKind: await planOf(EXPLAIN_CALL("policy.current_client_kind()")),
    },
  };
  return { rulings: await planOf(EXPLAIN_RULINGS), facts, names: await planOf(EXPLAIN_NAMES), keys };
}

async function measureBeliefs(
  own: Own,
  query: Query,
  token: string,
  { subjects = 50, now = new Date() }: { subjects?: number; now?: Date } = {},
): Promise<BeliefsMeasure | "unauthorized"> {
  // As the reader serves a client: under its token, so row security holds the read to the
  // client's clearance. The card opens no session.
  await query(SET_TOKEN, [token]);
  const [client] = await query<{ compartments: string[]; views: PersonalView[] }>(
    "select compartments, views from policy.current_client()",
  );
  if (client === undefined) return "unauthorized";
  const top = await query<{ entity_id: EntityId }>(TOP_SUBJECTS, [subjects]);
  const ctx = clientCtx(own, query, client.compartments);
  const samples: number[] = [];
  let notFound = 0;
  for (const { entity_id } of top) {
    const { ms, value } = await timed(() => readCard(ctx, { id: entity_id }, now, client.views));
    samples.push(ms);
    if (value === null) notFound += 1;
  }
  const asOf = now.toISOString();
  const factKeys = (await query<{ fact_key_fp: string }>(VISIBLE_KEYS, [[...BELIEF_TYPES]])).map(
    (row) => row.fact_key_fp,
  );
  const beliefsOf = async (some: string[]) =>
    beliefAt(await readBeliefInputs(query, ctx.keys, some, asOf), client.compartments, some, asOf);
  const perKey: number[] = [];
  for (const key of factKeys) perKey.push((await timed(() => beliefsOf([key]))).ms);
  let rows = 0;
  const all = await timed(async () => {
    for (let start = 0; start < factKeys.length; start += BELIEF_INPUTS_MAX)
      rows += (await beliefsOf(factKeys.slice(start, start + BELIEF_INPUTS_MAX))).length;
  });
  return {
    getEntity: { ...percentiles(samples), subjects: top.length, notFound },
    beliefsFor: {
      audienceCompartments: client.compartments.length,
      keys: factKeys.length,
      rows,
      perKey: percentiles(perKey),
      allMs: Math.round(all.ms * 100) / 100,
    },
  };
}

async function measureDisputes(own: Own, query: Query): Promise<DisputesMeasure> {
  const [owner] = await query<{ audience: string[] }>(OWNER_AUDIENCE, [[...BELIEF_TYPES]]);
  const audience = owner?.audience ?? [];
  // Every belief computed for the owner's audience, as pi_pipeline (policy.belief_inputs_under).
  const ctx: Ctx = { ...clientCtx(own, query, audience), keys: own.keys };
  const beliefs =
    audience.length === 0
      ? []
      : (await everyBelief(ctx, new Date(), Number.MAX_SAFE_INTEGER - 1, { audience })).beliefs;
  const disputedByKind: Record<string, number> = {};
  const wordingOnlyByKind: Record<string, number> = {};
  for (const { row, belief } of beliefs) {
    if (!belief.disputed) continue;
    disputedByKind[belief.kind] = (disputedByKind[belief.kind] ?? 0) + 1;
    const claims = await query<{ id: string; compartments: string[]; content_enc: Sealed }>(
      "select id, compartments, content_enc from knowledge.claims where id = any($1) order by id",
      [row.support],
    );
    const sides = new Set(
      claims.map((claim) => {
        const record = JSON.parse(open(own.keys, claim, "knowledge.claims.content_enc", "throw"));
        return sideOf(ClaimRecord.parse(record).claim.content.fields);
      }),
    );
    if (sides.size > 1 && new Set([...sides].map(wording)).size === 1)
      wordingOnlyByKind[belief.kind] = (wordingOnlyByKind[belief.kind] ?? 0) + 1;
  }
  return { audienceCompartments: audience.length, beliefs: beliefs.length, disputedByKind, wordingOnlyByKind };
}

async function measureProjects(query: Query, { runs = 20 }: { runs?: number } = {}): Promise<ProjectsMeasure> {
  const sizes = await query<{ project_id: string; items: number }>(PROJECT_SIZES);
  const [largest] = sizes;
  if (largest === undefined) return { projects: 0, items: 0, claims: 0, runs: 0, ms: percentiles([]) };
  const samples: number[] = [];
  let claims = 0;
  for (let run = 0; run < runs; run += 1) {
    const { ms, value } = await timed(() =>
      query<{ evidence_id: string; claim_id: string | null }>(PROJECT_LINKS, [largest.project_id]),
    );
    samples.push(ms);
    claims = value.filter((row) => row.claim_id !== null).length;
  }
  return { projects: sizes.length, items: largest.items, claims, runs, ms: percentiles(samples) };
}
