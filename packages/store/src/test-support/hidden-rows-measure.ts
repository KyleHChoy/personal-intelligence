// What the asks of invariant 6's world cost the server: each ask's statements recorded and run
// again under explain, the plans checked against the label key and the one-row lookups (I2, I3),
// and the reads that a clearance of many compartments weighs on, timed and compared.

import pg from "pg";
import { parseDatabaseUrl } from "../core/db.ts";
import { Reader } from "../read/read.ts";
import { SET_TOKEN } from "../read/read-db.ts";
import type { Ask } from "./hidden-rows-asks.ts";
import { admin, INV6_NOW, type Inv6, visiblePeople } from "./hidden-rows-world.ts";
import type { SentStatement } from "./recording.ts";

// The calls one capture, or one explain, runs at once, each on a connection of its own. The
// measures wait on the server, which has the cores for more than AT_ONCE.
const MEASURE_AT_ONCE = 10;
// The longest one captured or explained statement may run. A statement that reads rows it should
// not, or a policy function that runs per row, fails the run within seconds, by its ask and its
// text, instead of holding the slow group for most of an hour (a per-row withheld check takes
// 1-2 s a statement). Every statement of a correct read runs in milliseconds in the 10 000-row
// world.
export const STATEMENT_LIMIT_MS = 5_000;

export type Captured = { ask: string; statements: SentStatement[] };

// The list each recorded connection records into, for the ask it is running (null between
// asks), across every capture running: one patch of pg.Client's query, made while any capture
// runs and taken out when the last ends, so captures may run at once (measured).
const recording = new Map<pg.Client, SentStatement[] | null>();
const unpatched = pg.Client.prototype.query;
let capturing = 0;
function recordStatements(): () => void {
  if (capturing++ === 0) {
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]): unknown {
      const list = recording.get(this);
      if (list != null) {
        const [first, second] = args;
        const config =
          typeof first === "object" && first !== null ? (first as { text?: unknown; values?: unknown }) : {};
        const values = Array.isArray(second) ? second : Array.isArray(config.values) ? config.values : [];
        list.push({
          text: typeof first === "string" ? first : String(config.text ?? ""),
          values: [...values],
          rows: 0,
        });
      }
      return (unpatched as (...given: unknown[]) => unknown).apply(this, args);
    } as typeof unpatched;
  }
  return () => {
    if (--capturing === 0) pg.Client.prototype.query = unpatched;
  };
}

// The statements each ask sent, with their values, as s.store.reader sends them. Up to MEASURE_AT_ONCE
// asks run at a time, each worker on a reader of its own over one connection whose statements
// it records; each worker's session is opened first by a call that is not captured, so every
// ask's statements are those of a later call.
export async function captured(s: Inv6, asks: readonly Ask[], token = s.viewer): Promise<Captured[]> {
  const out: Captured[] = new Array<Captured>(asks.length);
  const done = recordStatements();
  let next = 0;
  const worker = async (): Promise<void> => {
    const pool = new pg.Pool({
      connectionString: s.store.db.urls.reader,
      max: 1,
      statement_timeout: STATEMENT_LIMIT_MS,
    });
    let mine: pg.Client | undefined;
    pool.on("connect", (client) => {
      mine = client;
      recording.set(client, null);
    });
    const reader = new Reader({ pool, keys: s.store.db.keys, log: s.store.log, now: () => INV6_NOW });
    try {
      await reader.getSelf(token);
      for (let at = next++; at < asks.length; at = next++) {
        const { ask, call } = asks[at] as Ask;
        const statements: SentStatement[] = [];
        if (mine !== undefined) recording.set(mine, statements);
        await call(reader, token);
        if (mine !== undefined) recording.set(mine, null);
        out[at] = { ask, statements };
      }
    } finally {
      if (mine !== undefined) recording.delete(mine);
      await pool.end();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(MEASURE_AT_ONCE, asks.length) }, worker));
  } finally {
    done();
  }
  return out;
}

// One world's measure, for I2 and I3 alike: every ask's statements for the viewer and for the
// client cleared for the cap's 32 compartments, then each run again under explain. The two
// clients' captures run at once, and then their explains: every call of both is stored before any
// statement is explained, so what the explains read of the logs is the same in every world.
export type Measured = { viewer: Explained[]; cap: Explained[]; calls: { viewer: Captured[]; cap: Captured[] } };
export async function measured(s: Inv6, asks: readonly Ask[]): Promise<Measured> {
  const [viewer, cap] = await Promise.all([captured(s, asks, s.viewer), captured(s, asks, s.cap)]);
  const [one, other] = await Promise.all([explained(s, viewer), explained(s, cap)]);
  return { viewer: one, cap: other, calls: { viewer, cap } };
}

// The reads a clearance's keys weigh on, as the reader serves them.
async function capCalls(s: Inv6): Promise<[string, (token: string) => Promise<unknown>][]> {
  const [person] = await visiblePeople(s);
  if (person === undefined) throw new Error("the world has no visible person");
  return [
    ["find_facts", (token) => s.store.reader.findFacts(token, {})],
    ["get_entity", (token) => s.store.reader.getEntity(token, { id: person as never })],
    ["search", (token) => s.store.reader.search(token, { query: s.base.owner.name })],
  ];
}

// What the keys of a clearance of many compartments cost, for the client cleared for ten and the
// one cleared for the cap's 32, on one world: the keys themselves, the withheld entities (an
// InitPlan of every entity read), a bulk read of the entities,
// and find_facts, get_entity and search as the reader serves them. Each is the median of REPEATS
// runs' wall time, in milliseconds; a statement runs on the reader's own login under the client's
// token and SET_TOKEN, as a call's statements do.
export type CapTiming = { read: string; ten: number; cap: number };
const REPEATS = 5;
export async function capTimings(s: Inv6): Promise<CapTiming[]> {
  const statements: [string, string][] = [
    ["clearance_keys", "select cardinality(policy.clearance_keys())"],
    ["withheld_entities", "select cardinality(policy.withheld_entities())"],
    ["bulk entity read", "select count(*) from knowledge.entities"],
  ];
  const calls = await capCalls(s);
  const median = async (run: () => Promise<unknown>): Promise<number> => {
    const times: number[] = [];
    for (let k = 0; k < REPEATS; k += 1) {
      const start = performance.now();
      await run();
      times.push(performance.now() - start);
    }
    return times.sort((x, y) => x - y)[Math.floor(REPEATS / 2)] as number;
  };
  const client = new pg.Client({
    connectionString: parseDatabaseUrl(s.store.db.urls.reader).href,
    statement_timeout: STATEMENT_LIMIT_MS,
  });
  await client.connect();
  try {
    const statement = async (text: string, token: string): Promise<number> => {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      try {
        await client.query(SET_TOKEN, [token]);
        return await median(() => client.query(text));
      } finally {
        await client.query("ROLLBACK");
      }
    };
    const out: CapTiming[] = [];
    for (const [read, text] of statements)
      out.push({ read, ten: await statement(text, s.ten), cap: await statement(text, s.cap) });
    for (const [read, call] of calls)
      out.push({ read, ten: await median(() => call(s.ten)), cap: await median(() => call(s.cap)) });
    return out;
  } finally {
    await client.end();
  }
}

// A reference policy.clearance_keys(): the key of every non-empty subset of the clearance, up to
// fourteen compartments. The reference the labels in use are held to (capReplies).
const SUBSET_KEYS = `create or replace function policy.clearance_keys()
returns text[]
language sql stable security definer
set search_path = pg_catalog, policy, pg_temp
as $$
  with one as (
    select x.one, (row_number() over (order by x.one collate "C"))::integer - 1 as bit
    from (select distinct c collate "C" as one from unnest(policy.client_clearance()) as c
          where policy.current_client_kind() is distinct from 'device') x
  ),
  n as (select count(*)::integer as n from one)
  select coalesce(array_agg(s.key order by s.key collate "C"), '{}'::text[])
  from n cross join lateral generate_series(1, case when n.n between 1 and 14 then (1 << n.n) - 1 else 0 end) as m (mask)
  cross join lateral (select string_agg(o.one, '|' order by o.one collate "C") as key from one o where (m.mask >> o.bit) & 1 = 1) s
$$`;

// The replies the keys could change, each as JSON: find_facts, get_entity and
// search for the client cleared for ten compartments and for the one cleared for the cap's 32
// (the same rows: the agent compartments past `own` and the wide client's hold nothing), and for
// the ten under the keys of every subset of its clearance (SUBSET_KEYS), put in place of
// policy.clearance_keys() as pi_owner for those calls and then put back. The cap's clearance has
// 2^32 - 1 subsets, so the subset keys are no reference for it; the ten's replies are.
export type CapReply = { read: string; ten: string; cap: string; tenSubsets: string };
export async function capReplies(s: Inv6): Promise<CapReply[]> {
  const calls = await capCalls(s);
  const out: CapReply[] = [];
  for (const [read, call] of calls)
    out.push({ read, ten: JSON.stringify(await call(s.ten)), cap: JSON.stringify(await call(s.cap)), tenSubsets: "" });
  const owner = new pg.Client({ connectionString: parseDatabaseUrl(s.store.db.urls.bootstrap).href });
  await owner.connect();
  try {
    await owner.query("set role pi_owner");
    const [current] = (
      await owner.query<{ text: string }>("select pg_get_functiondef('policy.clearance_keys()'::regprocedure) as text")
    ).rows;
    if (current === undefined) throw new Error("no policy.clearance_keys()");
    await owner.query(SUBSET_KEYS);
    try {
      for (const [index, [, call]] of calls.entries())
        (out[index] as CapReply).tenSubsets = JSON.stringify(await call(s.ten));
    } finally {
      await owner.query(current.text);
    }
  } finally {
    await owner.end();
  }
  return out;
}

// One node of a JSON plan, as `explain (format json)` gives it.
export type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  Schema?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  "Parent Relationship"?: string;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
};
export type Explained = { ask: string; index: number; text: string; plan: PlanNode | null };

// A plan with the fields PlanNode names and no other, at every node. The rest (costs, rows, each
// node's output list) is most of a plan's size, no check reads it, and every plan of both worlds
// is held until the tests end: kept whole, they made the second world's measure wait on the
// garbage collector.
const PLAN_FIELDS = [
  "Node Type",
  "Relation Name",
  "Schema",
  "Index Name",
  "Index Cond",
  "Recheck Cond",
  "Parent Relationship",
  "Shared Hit Blocks",
  "Shared Read Blocks",
] as const;
function pruned(node: PlanNode): PlanNode {
  const kept: Record<string, unknown> = {};
  for (const field of PLAN_FIELDS) if (node[field] !== undefined) kept[field] = node[field];
  if (node.Plans !== undefined) kept.Plans = node.Plans.map(pruned);
  return kept as PlanNode;
}

const CONTROL = /^(BEGIN|COMMIT|ROLLBACK)\b/i;

// Each captured call run again on the reader's own login, in one transaction that is rolled
// back: every statement in order with its values, each under `explain (analyze, buffers,
// verbose, format json)`, which runs it as well, so the token statement still sets the token
// and every later statement sees what it saw. A statement that is the transaction's own has no
// plan. The statements inside a definer function are counted in their caller's buffers, and
// their plans are not seen: the server's auto_explain needs a superuser to load, and the local
// server has none (docker-compose.yml).
export async function explained(s: Inv6, calls: readonly Captured[]): Promise<Explained[]> {
  // Up to MEASURE_AT_ONCE calls at a time, each on its own login; each call's plans in its place.
  const plans: Explained[][] = new Array<Explained[]>(calls.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    const client = new pg.Client({
      connectionString: parseDatabaseUrl(s.store.db.urls.reader).href,
      statement_timeout: STATEMENT_LIMIT_MS,
    });
    await client.connect();
    try {
      for (let at = next++; at < calls.length; at = next++) {
        const { ask, statements } = calls[at] as Captured;
        const out: Explained[] = [];
        const begin =
          statements.find((one) => /^BEGIN\b/i.test(one.text))?.text ?? "BEGIN ISOLATION LEVEL REPEATABLE READ";
        await client.query(begin);
        try {
          for (const [index, { text, values }] of statements.entries()) {
            if (CONTROL.test(text.trim())) continue;
            const { rows } = await client
              .query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
                `explain (analyze, buffers, verbose, timing off, format json) ${text}`,
                values,
              )
              .catch((error: unknown) => {
                throw new Error(
                  `${ask}, statement ${index}: ${error instanceof Error ? error.message : String(error)} (limit ${STATEMENT_LIMIT_MS} ms): ${text.replaceAll(/\s+/g, " ").trim().slice(0, 200)}`,
                );
              });
            const plan = rows[0]?.["QUERY PLAN"][0]?.Plan;
            out.push({ ask, index, text, plan: plan === undefined ? null : pruned(plan) });
          }
        } finally {
          await client.query("ROLLBACK");
        }
        plans[at] = out;
      }
    } finally {
      await client.end();
    }
  };
  await Promise.all(Array.from({ length: Math.min(MEASURE_AT_ONCE, calls.length) }, worker));
  return plans.flat();
}

// Every node of a plan, depth first.
export const nodesOf = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];

const SCANS = new Set([
  "Seq Scan",
  "Index Scan",
  "Index Only Scan",
  "Bitmap Heap Scan",
  "Tid Scan",
  "Tid Range Scan",
  "Sample Scan",
]);
export const scansOf = (plan: PlanNode): PlanNode[] => nodesOf(plan).filter((node) => SCANS.has(node["Node Type"]));
export const buffersOf = (node: PlanNode): number =>
  (node["Shared Hit Blocks"] ?? 0) + (node["Shared Read Blocks"] ?? 0);

// The tables the label key serves: every table with a `compartments` column that pi_reader has a select
// policy on, and knowledge.entities, which a reader reaches only by its primary key or by the owner's
// index. And the indexes a lookup of one row may use, each with its columns: each primary key, each
// unique index of one column, and the owner's.
export type Known = { labelled: Set<string>; lookups: Map<string, string[]> };
export async function catalogue(s: Inv6): Promise<Known> {
  const labelled = await admin<{ name: string }>(
    s,
    `select distinct p.schemaname || '.' || p.tablename as name from pg_policies p
     join information_schema.columns c on c.table_schema = p.schemaname and c.table_name = p.tablename and c.column_name in ('compartments', 'audience')
     where 'pi_reader' = any (p.roles)`,
  );
  const lookups = await admin<{ name: string; columns: string[] }>(
    s,
    `select c.relname as name, array_agg(a.attname::text order by k.place) as columns
     from pg_index i
     join pg_class c on c.oid = i.indexrelid
     join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
     cross join lateral unnest(i.indkey) with ordinality as k (attnum, place)
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
     where n.nspname in ('knowledge', 'projections', 'ledger')
       and (i.indisprimary or (i.indisunique and i.indnatts = 1 and i.indpred is null) or c.relname = 'entities_one_owner')
     group by c.relname`,
  );
  return {
    labelled: new Set([...labelled.map((row) => row.name), "knowledge.entities"]),
    lookups: new Map(lookups.map((row) => [row.name, row.columns])),
  };
}

// A scan of any other kind of a labelled table is a fault too.
export function planFaults(plan: PlanNode, known: Known): string[] {
  const faults: string[] = [];
  const keyed = (node: PlanNode): boolean => /label_key\(/.test(node["Index Cond"] ?? "");
  // Every column of the index set equal to one value, or to each of a list: a prefix of a
  // primary key of two columns reads every row under that prefix, of any label, and is no lookup.
  const lookup = (node: PlanNode): boolean => {
    const cond = node["Index Cond"] ?? "";
    const columns = known.lookups.get(node["Index Name"] ?? "");
    if (columns === undefined || cond === "" || /[<>]|~~|\bOR\b/i.test(cond)) return false;
    return columns.every((column) => new RegExp(`(^|[(.\\s])${column} = `).test(cond));
  };
  // The planner states no condition when the query's own `kind = 'owner'` implies the index's predicate, so
  // that scan is accepted with no condition or with exactly that one, on knowledge.entities only: it reads
  // one row at most, the owner's, the same for every caller.
  const owner = (relation: string, node: PlanNode): boolean =>
    relation === "knowledge.entities" &&
    node["Index Name"] === "entities_one_owner" &&
    /^(\(([a-z_0-9]+\.)?kind = 'owner'::text\))?$/.test(node["Index Cond"] ?? "");
  const visit = (node: PlanNode): void => {
    const relation = node["Relation Name"] === undefined ? undefined : `${node.Schema ?? ""}.${node["Relation Name"]}`;
    if (relation !== undefined && known.labelled.has(relation)) {
      const type = node["Node Type"];
      if (type === "Index Scan" || type === "Index Only Scan") {
        if (!keyed(node) && !lookup(node) && !owner(relation, node))
          faults.push(`${relation}: ${type} on ${node["Index Name"] ?? "?"} by ${node["Index Cond"] ?? "nothing"}`);
      } else if (type === "Bitmap Heap Scan") {
        const indexes = nodesOf(node).filter((one) => one["Node Type"] === "Bitmap Index Scan");
        for (const one of indexes)
          if (!keyed(one) && !lookup(one) && !owner(relation, one))
            faults.push(
              `${relation}: Bitmap Index Scan on ${one["Index Name"] ?? "?"} by ${one["Index Cond"] ?? "nothing"}`,
            );
      } else if (SCANS.has(type)) faults.push(`${relation}: ${type}`);
    }
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan);
  return faults;
}
