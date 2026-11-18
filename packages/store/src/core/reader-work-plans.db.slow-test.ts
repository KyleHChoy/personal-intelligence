import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SET_TOKEN } from "../read/read-db.ts";
import { labelsMissing, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { type Ask, asksOf } from "../test-support/hidden-rows-asks.ts";
import {
  buffersOf,
  type Captured,
  capReplies,
  capTimings,
  captured,
  catalogue,
  type Explained,
  explained,
  type Measured,
  measured,
  nodesOf,
  planFaults,
  STATEMENT_LIMIT_MS,
  scansOf,
} from "../test-support/hidden-rows-measure.ts";
import { type Inv6, openInv6, timed } from "../test-support/hidden-rows-world.ts";

// I2 and I3 of invariant 6 for the reader, over one measure of each world: one file, so each world
// is built and measured once for both.
//
// I2, work equality: every statement of I1's read tool asks, captured with its values and run again
// on the reader's own login under the same token with `explain (analyze, buffers)`, reads within 2
// buffers per scan node of the same statement in the base world, once 10 000 hidden rows are added
// per labelled table about the same people, senders, domains and threads. For a client cleared for
// `own`, and for one cleared for 32 compartments. A definer function's buffers are counted whole in
// the statement that calls it. Control: with the key term taken out of the messages policy, a
// sender's statement reads at least ten times more.
//
// Left out of I2, and why: the four log functions (policy.log_call, log_read, open_session,
// log_pack) append to the owner's logs, whose pages grow with every call and with nothing hidden,
// so their buffers are no measure of hidden rows.
//
// I3, plan shape: no statement of I1's read tool asks plans a sequential scan of a labelled table
// or of knowledge.entities, and every scan of a labelled table is an index or bitmap scan whose
// index condition holds the label key, or a lookup by equality on a primary key or a unique index
// of one column; the entities are reached by their primary key or the owner's index alone. On the
// base world and on the hidden world: the spec's hidden world, the one I2 measures, with 10 000
// hidden rows per labelled table. Every index the plans use on knowledge.messages and
// ledger.agent_writes serves the policy's other terms.
//
// Not in I3, and why (the report says so): the plans inside the definer functions. The spec has the
// test load auto_explain as the test superuser; the local server has no superuser
// (docker-compose.yml: postgres cannot log in, migrator is not one), and auto_explain's settings
// need one. I11 checks those functions' text instead.
//
// Its time: the standard is five minutes. Each world is a template database built once per key
// and copied (hidden-rows-world.ts, openInv6). Its hidden twin is stored by sixteen writers and
// committed by sixteen pipelines at once, through the real writer and pipeline. The base world is
// measured while the hidden world is built and then measured, and each world's measure runs its
// two clients at once.
// Plans keep only the fields the checks read. Each phase's seconds are written to stderr as
// `inv6 phase:`. Most of the time is the server's work: every statement runs twice, once captured
// and once explained. A client's keys are the labels in use within its clearance, a handful, not
// every subset: at fourteen compartments every subset is 16 383 keys, too many to finish.
//
// Do not weaken, skip or delete this test to make a change pass.

// Above SLOW_DB_TEST_TIMEOUT (test-support/timeouts.ts): a slow-group file that builds and
// measures worlds of 10 000 hidden rows per labelled table.
const TIMEOUT = 3_600_000;
const PER_TABLE = 10_000;
const LOGS = /policy\.(log_call|log_read|open_session|log_pack)\(/;

let s: Inv6;
let asks: Ask[];
let known: Awaited<ReturnType<typeof catalogue>>;
let base: Measured;
let hidden: Measured;
// The labels the base world's rows hold that policy.labels lacks, read once it is built.
let baseMissing: string[];

beforeAll(async () => {
  // The base world is measured while the hidden world, a copy of it with the twin added, is
  // built once (openInv6) and then measured: two databases, each with every call of its own.
  const world = await timed("open base", () => openInv6());
  try {
    asks = await asksOf(world);
    known = await catalogue(world);
    baseMissing = await labelsMissing(world.store.db.urls.bootstrap);
    const measuring = timed("measure base", () => measured(world, asks));
    // Awaited below, once the hidden world is measured or has failed.
    measuring.catch(() => {});
    try {
      s = await timed("open hidden", () => openInv6(PER_TABLE));
      hidden = await timed("measure hidden", () => measured(s, asks));
    } finally {
      base = await measuring;
    }
  } finally {
    await world.close();
  }
}, TIMEOUT);

afterAll(async () => {
  await s?.close();
});

// Both clients' plans, as I3 reads them.
const plansOf = (world: Measured): Explained[] => [...world.viewer, ...world.cap];

// Each statement whose buffers differ by more than its tolerance: 2 per scan node.
function overTolerance(was: Explained[], now: Explained[]): string[] {
  const faults: string[] = [];
  expect(now.map((one) => `${one.ask} ${one.text}`)).toEqual(was.map((one) => `${one.ask} ${one.text}`));
  for (const [index, one] of was.entries()) {
    const other = now[index];
    if (one.plan === null || other?.plan == null || LOGS.test(one.text)) continue;
    const tolerance = 2 * Math.max(1, scansOf(one.plan).length, scansOf(other.plan).length);
    const [b, h] = [buffersOf(one.plan), buffersOf(other.plan)];
    if (Math.abs(h - b) > tolerance)
      faults.push(
        `${one.ask}: ${b} buffers became ${h} (tolerance ${tolerance}) in ${one.text.replaceAll(/\s+/g, " ").trim().slice(0, 200)}`,
      );
  }
  return faults;
}

describe("I2: a statement's work does not grow with rows the caller cannot see", { timeout: TIMEOUT }, () => {
  it("the same statements are sent in both worlds, each with a plan", () => {
    expect(hidden.calls.viewer.map((one) => one.statements.map((x) => x.text))).toEqual(
      base.calls.viewer.map((one) => one.statements.map((x) => x.text)),
    );
    expect(base.viewer.filter((one) => one.plan !== null).length).toBeGreaterThan(asks.length);
  });

  // Fails on real gaps until the invariant 6 index work lands; remove .fails when it passes.
  it.fails("for a client cleared for own, every statement reads within 2 buffers per scan node of the base world", () => {
    expect(overTolerance(base.viewer, hidden.viewer)).toEqual([]);
  });

  // Fails on real gaps until the invariant 6 index work lands; remove .fails when it passes.
  it.fails("for a client cleared for 32 compartments (the cap), every statement reads within 2 buffers per scan node of the base world", () => {
    expect(overTolerance(base.cap, hidden.cap)).toEqual([]);
  });

  it("control: with the key term taken out of the messages policy, a sender's statement reads at least ten times more", async () => {
    const asked = asks.filter((one) => one.ask.startsWith("find_messages sender "));
    const was = base.viewer.filter(
      (one) => one.ask.startsWith("find_messages sender ") && /from knowledge\.messages/.test(one.text),
    );
    expect(was.length).toBeGreaterThan(0);

    // On a copy of the hidden world of its own, dropped after it, so I3 below reads the hidden
    // world with its policies as they are: the policy as it was before the key term.
    const own = await openInv6(PER_TABLE);
    try {
      await session(own.store.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query(
          "alter policy pi_reader_select on knowledge.messages using (compartments <@ (select policy.client_clearance()) and not held)",
        );
      });
      const now = await explained(own, await captured(own, asked, own.viewer));
      const statement = (list: Explained[]) =>
        list.filter((one) => /from knowledge\.messages/.test(one.text) && one.plan !== null);
      const pairs = statement(was).map((one) => [one, statement(now).find((other) => other.ask === one.ask)] as const);
      const growth = Math.max(
        ...pairs.map(([one, other]) =>
          other?.plan == null || one.plan === null ? 0 : buffersOf(other.plan) / Math.max(1, buffersOf(one.plan)),
        ),
      );
      expect(growth).toBeGreaterThanOrEqual(10);
      // And I2's own check fails such a statement: a plan that reads hidden rows is over its tolerance.
      const found = pairs.flatMap(([one, other]) => (other === undefined ? [] : [[one, other] as const]));
      expect(
        overTolerance(
          found.map(([one]) => one),
          found.map(([, other]) => other),
        ).length,
      ).toBeGreaterThan(0);
    } finally {
      await own.close();
    }
  });
});

// The accepted residuals, provisional, as the threat model's "Known limitations" accepts them under
// "Invariant 6 is not fully held", where these three are named: indexes that back a key or unique
// constraint, so no migration can drop them, which the planner may choose on their own table
// without the label key. A closed list: a scan by any other index without the key, of any table,
// is still a fault, and so is one of these on another table. Each is checked below to back a
// constraint.
//   - claim_entities_pkey (claim_id, entity_id): a claim's entities by its id. Every row a
//     claim names is written under the claim's own label, so the prefix holds no other label's rows.
//   - event_participants_pkey (event_id, entity_id): an event's participants by its id, likewise
//     written under the event's label.
//   - accounts_value_compartments_entity (value_fp, compartments, entity_id): an address's rows by
//     its fingerprint, one per compartment that saw it: at most one entry per compartment.
const RESIDUALS: ReadonlyMap<string, string> = new Map([
  ["claim_entities_pkey", "knowledge.claim_entities"],
  ["event_participants_pkey", "knowledge.event_participants"],
  ["accounts_value_compartments_entity", "knowledge.accounts"],
]);
const accepted = (fault: string): boolean => {
  const found = /^([a-z_]+\.[a-z_]+): (?:Index Scan|Index Only Scan|Bitmap Index Scan) on ([a-z_0-9]+) by /.exec(fault);
  return found !== null && RESIDUALS.get(found[2] ?? "") === found[1];
};

// Each fault, once, with the first ask that showed it, but for the accepted residuals.
function faultsOf(list: Explained[]): string[] {
  const found = new Map<string, string>();
  for (const one of list) {
    if (one.plan === null) continue;
    for (const fault of planFaults(one.plan, known).filter((each) => !accepted(each))) {
      const key = `${fault} | ${one.text.replaceAll(/\s+/g, " ").trim().slice(0, 160)}`;
      if (!found.has(key)) found.set(key, one.ask);
    }
  }
  return [...found].map(([fault, ask]) => `${ask}: ${fault}`);
}

describe("I3: every reader statement reaches a labelled table by the label key", { timeout: TIMEOUT }, () => {
  it("the catalogue names the labelled tables and the lookups", () => {
    for (const table of [
      "knowledge.messages",
      "knowledge.accounts",
      "knowledge.interaction_log",
      "knowledge.claims",
      "ledger.agent_writes",
      "knowledge.entities",
    ]) {
      expect(known.labelled.has(table), table).toBe(true);
    }
    for (const index of ["entities_pkey", "entities_one_owner", "messages_pkey", "messages_evidence"])
      expect(known.lookups.has(index), index).toBe(true);
    expect(known.lookups.has("accounts_value_compartments_entity")).toBe(false);
  });

  it("each accepted residual backs a constraint of its table", async () => {
    const rows = await queryAs<{ index: string; table: string }>(
      s.store.db.urls.admin,
      `select i.relname as index, n.nspname || '.' || t.relname as table from pg_constraint c
       join pg_class i on i.oid = c.conindid join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
       where i.relname = any ($1) order by 1`,
      [[...RESIDUALS.keys()]],
    );
    expect(rows).toEqual(
      [...RESIDUALS].map(([index, table]) => ({ index, table })).sort((x, y) => (x.index < y.index ? -1 : 1)),
    );
    // The list is closed: a scan by any other index without the key stays a fault.
    expect(accepted("knowledge.accounts: Index Scan on accounts_entity by (a.entity_id = $1)")).toBe(false);
    expect(accepted("knowledge.accounts: Index Scan on claim_entities_pkey by (a.claim_id = $1)")).toBe(false);
    expect(accepted("knowledge.claim_entities: Index Scan on claim_entities_pkey by (c.claim_id = $1)")).toBe(true);
  });

  // Fails on real gaps until the invariant 6 index work lands; remove .fails when it passes.
  it.fails("on the base world, no statement plans a scan of a labelled table but by the key or one lookup", () => {
    expect(plansOf(base).filter((one) => one.plan !== null).length).toBeGreaterThan(asks.length);
    expect(faultsOf(plansOf(base))).toEqual([]);
  });

  // Fails on real gaps until the invariant 6 index work lands; remove .fails when it passes.
  it.fails("on the hidden world, no statement plans a scan of a labelled table but by the key or one lookup", () => {
    expect(faultsOf(plansOf(hidden))).toEqual([]);
  });

  it("every index the plans use on messages and agent records serves the policy's other terms (R37)", async () => {
    const definitions = new Map(
      (
        await queryAs<{ name: string; definition: string }>(
          s.store.db.urls.admin,
          "select indexname as name, indexdef as definition from pg_indexes where schemaname in ('knowledge', 'ledger')",
        )
      ).map((row) => [row.name, row.definition]),
    );
    const used = new Set(
      [...plansOf(base), ...plansOf(hidden)].flatMap((one) =>
        one.plan === null
          ? []
          : nodesOf(one.plan).flatMap((node) =>
              node["Index Name"] !== undefined && /label_key\(/.test(node["Index Cond"] ?? "")
                ? [node["Index Name"]]
                : [],
            ),
      ),
    );
    for (const name of used) {
      const definition = definitions.get(name) ?? "";
      if (/ON knowledge\.messages /.test(definition)) expect(definition, name).toMatch(/WHERE \(NOT held\)$/);
      if (/ON ledger\.agent_writes /.test(definition))
        expect(definition, name).toMatch(/WHERE \(flagged_at IS NULL\)$/);
    }
  });

  it("control: a statement that reads every entity, and one that walks the messages by time alone, are faults", async () => {
    const call = (text: string): Captured => ({
      ask: "control",
      statements: [
        { text: "BEGIN ISOLATION LEVEL REPEATABLE READ", values: [], rows: 0 },
        { text: SET_TOKEN, values: [s.viewer], rows: 1 },
        { text, values: [], rows: 0 },
      ],
    });
    const [entities] = (
      await explained(s, [call("select e.id from knowledge.entities e where e.kind = 'person' order by e.id")])
    ).filter((one) => one.text.includes("knowledge.entities"));
    expect(entities?.plan).toBeDefined();
    expect(planFaults(entities?.plan ?? { "Node Type": "Result" }, known).length).toBeGreaterThan(0);
    // The messages by time: its plan with the key taken out of every condition, as a policy
    // without the key term would give, is a fault.
    const [walk] = (
      await explained(s, [
        call("select m.id from knowledge.messages m where not m.held order by m.sent_at desc, m.id limit 5"),
      ])
    ).filter((one) => one.text.includes("knowledge.messages"));
    expect(walk?.plan).toBeDefined();
    const stripped = JSON.parse(JSON.stringify(walk?.plan ?? {}).replaceAll("label_key(", "no_key(")) as Parameters<
      typeof planFaults
    >[0];
    expect(planFaults(stripped, known).length).toBeGreaterThan(0);
  });
});

// The check that gates the cap. I2 and I3 above are informational for it until the invariant 6
// index work lands (their cap-client cases are it.fails). On the hidden world, each read the keys
// weigh on, timed for a client cleared for ten compartments and one cleared for the cap's 32. For
// the five reads a caller makes (withheld_entities, the bulk entity read, find_facts, get_entity
// and search), the cap's median stays under 1 s and within ten times ten's (a floor of 1 ms, so a
// read too quick to time is no ratio). clearance_keys itself is reported only. The times go to
// stderr as `inv6 cap:`, a label and numbers. With a key for every subset of the clearance,
// fourteen compartments already failed this.
const CAP_READ_MS = 1_000;
describe("the cost of a clearance at the cap", { timeout: TIMEOUT }, () => {
  it("each read stays under 1 s and within ten times the same read for ten compartments", async () => {
    const timings = await capTimings(s);
    for (const one of timings)
      process.stderr.write(`inv6 cap: ${one.read} ten ${one.ten.toFixed(1)} ms cap ${one.cap.toFixed(1)} ms\n`);
    expect(timings.map((one) => one.read)).toEqual([
      "clearance_keys",
      "withheld_entities",
      "bulk entity read",
      "find_facts",
      "get_entity",
      "search",
    ]);
    for (const one of timings) {
      expect(one.cap, one.read).toBeLessThan(STATEMENT_LIMIT_MS);
      if (one.read === "clearance_keys") continue;
      expect(one.cap, one.read).toBeLessThan(CAP_READ_MS);
      expect(one.cap, one.read).toBeLessThanOrEqual(10 * Math.max(1, one.ten));
    }
  });

  // The labels in use change no reply. The ten-compartment client's replies under the labels in
  // use are byte for byte its replies under keys of every subset, and the cap's client, which sees
  // the same rows, gets byte for byte the ten's.
  it("find_facts, get_entity and search answer byte for byte as under every subset's keys, at ten and at the cap", async () => {
    const replies = await capReplies(s);
    expect(replies.map((one) => one.read)).toEqual(["find_facts", "get_entity", "search"]);
    for (const one of replies) {
      // Each is an answer, not a refusal: the control that the comparison compares something.
      expect(JSON.parse(one.ten), one.read).toMatchObject({ ok: true });
      expect(one.ten, one.read).toBe(one.tenSubsets);
      expect(one.cap, one.read).toBe(one.ten);
    }
  });
});

// Every label a row of a built world holds is in use: the base world, stored through the real
// writer and pipeline, and its hidden twin, stored by sixteen of each at once. Then the cost of
// many labels in use within the cap's clearance: 300 labels of `own` and two of the agent
// compartments the cap client holds (28 of them within the ten client's too), put in
// policy.labels directly as its owner, so no row holds them: each is a key that matches no row,
// the worst case for the keys. Each read is timed again, as above; the times go to stderr as
// `inv6 labels:`. The gate is the cap's rule: under 1 s.
describe("the labels in use in the built worlds", { timeout: TIMEOUT }, () => {
  it("every label a stored row holds is in policy.labels, in the base world and the hidden one", async () => {
    expect(baseMissing).toEqual([]);
    expect(await labelsMissing(s.store.db.urls.bootstrap)).toEqual([]);
  });

  it("with 300 more labels in use within the cap's clearance, each read stays under 1 s", async () => {
    const agents = Array.from({ length: 30 }, (_, index) => `agent:c${index + 1}`);
    const keys: string[] = [];
    for (let i = 0; i < agents.length && keys.length < 300; i += 1) {
      for (let j = i + 1; j < agents.length && keys.length < 300; j += 1)
        keys.push(["own", agents[i] ?? "", agents[j] ?? ""].sort().join("|"));
    }
    const added = await session(s.store.db.urls.bootstrap, async (query) => {
      await query("begin");
      await query("set local role pi_owner");
      const rows = await query<{ key: string }>(
        "insert into policy.labels (key, compartments) select k, string_to_array(k, '|') from unnest($1::text[]) k on conflict do nothing returning key",
        [keys],
      );
      await query("commit");
      return rows.length;
    });
    expect(added).toBe(300);
    const timings = await capTimings(s);
    for (const one of timings)
      process.stderr.write(`inv6 labels: ${one.read} ten ${one.ten.toFixed(1)} ms cap ${one.cap.toFixed(1)} ms\n`);
    for (const one of timings) {
      expect(one.cap, one.read).toBeLessThan(STATEMENT_LIMIT_MS);
      if (one.read === "clearance_keys") continue;
      expect(one.cap, one.read).toBeLessThan(CAP_READ_MS);
    }
  });
});
