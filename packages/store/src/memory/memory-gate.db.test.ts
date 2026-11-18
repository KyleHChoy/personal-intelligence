import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMORY_TABLES } from "../test-support/catalogue.ts";
import { asClaimsOwner, readAs, refusal, sqlState } from "../test-support/connections.ts";
import { createTestDatabase, queryAs, type TestDatabase } from "../test-support/database.ts";
import {
  beliefId,
  corrections,
  evidenceId,
  hex,
  type MemoryClient,
  memoryClient,
  projectionId,
  projectionOf,
  projectionsOf,
  removed,
  type Served,
  type Sync,
  seedBeliefs,
  serve,
  serveAll,
  served,
  serveValues,
  supportsOf,
  TEMPLATE,
  taint,
  valuesOf,
} from "../test-support/memory-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";

// A statement that changes or removes a claim, as the claims' owner: pi_admin may not.
const claimsAs = (db: TestDatabase, text: string, values: unknown[] = []): Promise<unknown> =>
  asClaimsOwner(db, (query) => query(text, values));

// The migration's tables and policy.serve_memory, called directly as pi_reader under a token. Every
// refusal has its positive control. The values are of the right forms and name nothing real. The
// function trusts the store for what an entry shows and finds each entry's evidence ids itself,
// from its belief, so each sync first writes the beliefs it serves (memory-fixtures.ts,
// seedBeliefs).

let db: TestDatabase;
let serial = 0;
const client = (
  clearance: string[] = ["own"],
  options: Parameters<typeof memoryClient>[3] = {},
): Promise<MemoryClient> => {
  serial += 1;
  return memoryClient(db, `memory-gate-${serial}`, clearance, options);
};

beforeAll(async () => {
  db = await createTestDatabase();
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await db.drop();
});

describe("the memory tables and policy.serve_memory", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the reader cannot select, insert, update or delete in a memory table", async () => {
    const one = await client();
    for (const table of MEMORY_TABLES) {
      for (const sql of [
        `select 1 from ${table}`,
        `insert into ${table} (compartments) values ('{own}')`,
        `update ${table} set compartments = compartments where false`,
        `delete from ${table} where false`,
      ]) {
        expect(await sqlState(() => readAs(db, one.token, (query) => query(sql))), `${table}: ${sql}`).toBe("42501");
      }
    }
    // The positive control: the function call that writes a row of one of them succeeds.
    expect(await serve(db, one.token, { entries: [served(1)] })).toEqual([]);
    expect((await projectionsOf(db, one)).map((row) => row.id)).toEqual([projectionId(1)]);
  });

  it("serve_memory takes the client from the token, never from an argument", async () => {
    // No argument names a client.
    const [signature] = await queryAs<{ args: string }>(
      db.urls.admin,
      "select pg_get_function_identity_arguments('policy.serve_memory'::regproc) as args",
    );
    expect(signature?.args).toBe(
      // The entries' line fingerprints come last.
      "template text, ids text[], fact_key_fps text[], state_fps text[], belief_ids text[], compartments jsonb, open_fact_key_fps text[], partial boolean, have text[], can_delete boolean, line_fps text[], supports jsonb",
    );
    const wide = await client(["employer:example", "own"]);
    expect(await serve(db, wide.token, { entries: [served(2)] })).toEqual([]);
    const [row] = await projectionsOf(db, wide);
    expect({ client: row?.client_id, audience: row?.audience }).toEqual({
      client: wide.id,
      audience: ["employer:example", "own"],
    });
    // No token, an unknown token and a revoked client's token are no client.
    const revoked = await client(["own"], { status: "revoked" });
    for (const token of [null, "pit_test-unknown", revoked.token])
      expect(await sqlState(() => serve(db, token, { entries: [served(3)] })), String(token)).toBe("42501");
    expect(
      await queryAs(db.urls.admin, "select id from ledger.memory_projections where id = $1", [projectionId(3)]),
    ).toEqual([]);
  });

  it("serve_memory refuses a client without the tool", async () => {
    const without = await client(["own"], { tools: ["get_self", "get_commitments"] });
    expect(await sqlState(() => serve(db, without.token, { entries: [served(4)] }))).toBe("42501");
    expect(await projectionsOf(db, without)).toEqual([]);
    // The control: the same call by a client that holds it.
    const holder = await client();
    expect(await serve(db, holder.token, { entries: [served(4)] })).toEqual([]);
  });

  it("serve_memory refuses an id that names another client's row, and that row is unchanged", async () => {
    const first = await client();
    const second = await client();
    await serve(db, first.token, { entries: [served(5)] });
    const before = await projectionOf(db, projectionId(5));
    expect(await sqlState(() => serve(db, second.token, { entries: [served(5, { state: hex("other-state") })] }))).toBe(
      "42501",
    );
    expect(await projectionOf(db, projectionId(5))).toEqual(before);
    expect(await projectionsOf(db, second)).toEqual([]);
    // The control: the second client's own id is taken.
    expect(await serve(db, second.token, { entries: [served(6)] })).toEqual([]);
  });

  it("an id off its form, a fingerprint that is not 64 hexadecimal characters, 41 ids, 201 have ids, arrays of unequal length and 5 001 open fact keys are each refused", async () => {
    const one = await client();
    const base = { entries: [served(7), served(8)] };
    const many = (count: number, from: number): Served[] => Array.from({ length: count }, (_, n) => served(from + n));
    const at = (values: unknown[], index: number, value: unknown): unknown[] =>
      values.map((old, n) => (n === index ? value : old));
    const cases: [string, unknown[], string][] = [
      ["an id off its form", valuesOf({ entries: [served(7, { id: "mpr_XYZ" })] }), "serve_memory_ids"],
      ["one id twice", valuesOf({ entries: [served(7), served(8, { id: projectionId(7) })] }), "serve_memory_ids"],
      ["41 ids", valuesOf({ entries: many(41, 100) }), "serve_memory_ids"],
      [
        "a fact key of 63 characters",
        valuesOf({ entries: [served(7, { fact: hex(7, 63) })] }),
        "serve_memory_fingerprints",
      ],
      [
        "a state in upper case",
        valuesOf({ entries: [served(7, { state: hex(7).toUpperCase().replace(/^0/, "A") })] }),
        "serve_memory_fingerprints",
      ],
      ["a belief id off its form", valuesOf({ entries: [served(7, { belief: "blf_1" })] }), "serve_memory_belief_ids"],
      ["an empty compartments", valuesOf({ entries: [served(7, { compartments: [] })] }), "serve_memory_compartments"],
      [
        "compartments out of order",
        valuesOf({ entries: [served(7, { compartments: ["own", "employer:example"] })] }),
        "serve_memory_compartments",
      ],
      [
        "a compartment beyond the clearance",
        valuesOf({ entries: [served(7, { compartments: ["employer:example"] })] }),
        "serve_memory_compartments",
      ],
      ["a template off its form", valuesOf({ ...base, template: "Active Memory" }), "serve_memory_template"],
      ["one fact key fewer", at(valuesOf(base), 2, [hex("fact-7")]), "serve_memory_lengths"],
      [
        "one belief id more",
        at(valuesOf(base), 4, [served(7).belief, served(8).belief, served(9).belief]),
        "serve_memory_lengths",
      ],
      ["one compartments list fewer", at(valuesOf(base), 5, JSON.stringify([["own"]])), "serve_memory_lengths"],
      [
        "5 001 open fact keys",
        valuesOf({ ...base, open: Array.from({ length: 5001 }, (_, n) => hex(`open-${n}`)) }),
        "serve_memory_open_fact_key_fps",
      ],
      [
        "201 have ids",
        valuesOf({ ...base, have: Array.from({ length: 201 }, (_, n) => projectionId(`have-${n}`)) }),
        "serve_memory_have",
      ],
      ["a have id twice", valuesOf({ ...base, have: [projectionId(9), projectionId(9)] }), "serve_memory_have"],
      ["a have id off its form", valuesOf({ ...base, have: ["mpr_1"] }), "serve_memory_have"],
    ];
    for (const [label, values, constraint] of cases) {
      expect(await refusal(() => serveValues(db, one.token, values)), label).toEqual({ code: "23514", constraint });
    }
    expect(await projectionsOf(db, one)).toEqual([]);
    // The controls: the largest sizes allowed are taken.
    expect(
      await serve(db, one.token, {
        entries: many(40, 200),
        open: Array.from({ length: 5000 }, (_, n) => hex(`open-${n}`)),
        have: Array.from({ length: 200 }, (_, n) => projectionId(`have-${n}`)),
      }),
    ).toHaveLength(200);
    expect(
      await serve(db, one.token, {
        entries: [
          served(7, { evidence: Array.from({ length: 500 }, (_, n) => evidenceId(`cap-${n}`)), compartments: ["own"] }),
        ],
      }),
    ).not.toEqual([]);
  });

  it("serve_memory finds each entry's evidence ids from its belief's support, each once and sorted, records them and answers them; no argument carries one", async () => {
    const one = await client();
    const entry = served(40, { evidence: [evidenceId("40-b"), evidenceId("40-a"), evidenceId("40-a")] });
    const evidence = [evidenceId("40-a"), evidenceId("40-b")].sort();
    const answer = await serveAll(db, one.token, { entries: [entry] });
    expect(answer).toEqual([
      {
        kind: "served",
        projection_id: entry.id,
        ended_at: null,
        reason: null,
        current_id: null,
        evidence_ids: evidence,
      },
    ]);
    expect((await projectionOf(db, entry.id)).evidence_ids).toEqual(evidence);
  });

  it("serve_memory refuses a belief that is gone, of another fact key or resting on a claim that is gone, and one with no evidence id or more than 500, before anything is written", async () => {
    const one = await client();
    const fresh = served(41);
    await seedBeliefs(db, one.compartments, [fresh]);
    const reextracted = served(42);
    await seedBeliefs(db, one.compartments, [reextracted]);
    // A re-extraction that has deleted the claims the entry names as its support.
    await claimsAs(db, "delete from knowledge.claims where id = any ($1)", [
      (JSON.parse(supportsOf({ entries: [reextracted] })) as string[][])[0],
    ]);
    const cases: [string, Sync, string][] = [
      ["a belief that is gone", { entries: [served(43)], seed: false }, "serve_memory_beliefs"],
      [
        "a belief of another fact key",
        { entries: [{ ...fresh, fact: hex("41-other-fact") }], seed: false },
        "serve_memory_beliefs",
      ],
      ["a belief whose claims are gone", { entries: [reextracted], seed: false }, "serve_memory_beliefs"],
      ["a belief with no evidence id", { entries: [served(44, { evidence: [] })] }, "serve_memory_evidence_ids"],
      [
        "a belief of 501 evidence ids",
        { entries: [served(45, { evidence: Array.from({ length: 501 }, (_, n) => evidenceId(`over-${n}`)) })] },
        "serve_memory_evidence_ids",
      ],
    ];
    for (const [label, sync, constraint] of cases) {
      expect(await refusal(() => serve(db, one.token, sync)), label).toEqual({ code: "23514", constraint });
    }
    expect(await projectionsOf(db, one)).toEqual([]);
    // The control: the belief as it was read.
    expect(await serve(db, one.token, { entries: [fresh], seed: false })).toEqual([]);
    expect((await projectionsOf(db, one)).map((row) => row.evidence_ids)).toEqual([fresh.evidence]);
  });

  it("serve_memory refuses a belief resting on a claim outside the client's clearance as serve_memory_beliefs, and takes one whose claims it sees", async () => {
    const narrow = await client(["own"]);
    const hidden = served(45, { compartments: ["employer:example"] });
    await seedBeliefs(db, ["employer:example", "own"], [hidden]);
    expect(
      await refusal(() => serve(db, narrow.token, { entries: [{ ...hidden, compartments: ["own"] }], seed: false })),
    ).toEqual({
      code: "23514",
      constraint: "serve_memory_beliefs",
    });
    expect(await projectionsOf(db, narrow)).toEqual([]);
    const entry = served(46);
    // The control: the belief built for the client's own audience.
    expect(await serve(db, narrow.token, { entries: [entry] })).toEqual([]);
    expect((await projectionsOf(db, narrow)).map((row) => row.audience)).toEqual([["own"]]);
  });

  it("an id served again takes the client's clearance now as its audience", async () => {
    const one = await client(["own"]);
    const entry = served(47);
    await serve(db, one.token, { entries: [entry] });
    await queryAs(db.urls.admin, "update policy.clients set compartments = '{employer:example,own}' where id = $1", [
      one.id,
    ]);
    await serve(db, one.token, { entries: [entry] });
    expect((await projectionOf(db, entry.id)).audience).toEqual(["employer:example", "own"]);
  });

  it("a served id has one row, and serving it again sets last_served_at, state_fp, belief_id and compartments and widens evidence_ids to the union", async () => {
    const wide = await client(["employer:example", "own"]);
    const first = served(10, { evidence: [evidenceId("b"), evidenceId("a")], compartments: ["own"] });
    await serve(db, wide.token, { entries: [first] });
    const before = await projectionOf(db, first.id);
    expect(before).toMatchObject({
      client_id: wide.id,
      template: TEMPLATE,
      fact_key_fp: first.fact,
      state_fp: first.state,
      belief_id: first.belief,
      evidence_ids: [evidenceId("a"), evidenceId("b")].sort(),
      compartments: ["own"],
      ended_at: null,
      reason: null,
    });
    expect(before.first_served_at).toEqual(before.last_served_at);
    const again = {
      ...first,
      state: hex("state-10-later"),
      belief: beliefId("10-later"),
      evidence: [evidenceId("c")],
      compartments: ["employer:example", "own"],
    };
    await serve(db, wide.token, { entries: [again] });
    const rows = await projectionsOf(db, wide);
    expect(rows).toHaveLength(1);
    const after = rows[0];
    expect(after).toMatchObject({
      state_fp: again.state,
      belief_id: again.belief,
      compartments: ["employer:example", "own"],
      evidence_ids: [evidenceId("a"), evidenceId("b"), evidenceId("c")].sort(),
    });
    expect(after?.first_served_at).toEqual(before.first_served_at);
    expect(after?.last_served_at.getTime()).toBeGreaterThan(before.last_served_at.getTime());
  });

  it("PT1: a served row is stored under its belief's label, never the label its caller passes", async () => {
    const wide = await client(["employer:example", "own"]);
    const belief = served(812, { compartments: ["employer:example", "own"] });
    await seedBeliefs(db, wide.compartments, [belief]);
    // A label of the right form, within the clearance, and not the belief's.
    for (const forged of [["own"], ["employer:example"]]) {
      const sync = { entries: [{ ...belief, compartments: forged }] };
      expect(await serveValues(db, wide.token, [...valuesOf(sync), supportsOf(sync)])).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "served", projection_id: belief.id })]),
      );
      expect(await projectionOf(db, belief.id)).toMatchObject({ compartments: ["employer:example", "own"] });
    }
  });

  it("a support-only change keeps the id, writes no correction and widens evidence_ids", async () => {
    const one = await client();
    const entry = served(11);
    expect(await serve(db, one.token, { entries: [entry], have: [] })).toEqual([]);
    const later = { ...entry, state: hex("state-11-confirmed"), evidence: [evidenceId("11-confirming")] };
    const answer = await serve(db, one.token, { entries: [later], have: [entry.id] });
    expect(corrections(answer)).toEqual([]);
    expect(removed(answer)).toEqual([]);
    expect(
      (await projectionsOf(db, one)).map((row) => ({ id: row.id, ended: row.ended_at, evidence: row.evidence_ids })),
    ).toEqual([{ id: entry.id, ended: null, evidence: [evidenceId(11), evidenceId("11-confirming")].sort() }]);
  });

  it("a live row that is not served is ended, changed with next_id when its fact key is served under another id, dropped when its fact key is open, withdrawn otherwise", async () => {
    const one = await client();
    const [changes, cut, gone] = [served(12), served(13), served(14)];
    await serve(db, one.token, { entries: [changes, cut, gone] });
    const replacement = served(15, { fact: changes.fact });
    const answer = await serve(db, one.token, {
      entries: [replacement],
      open: [changes.fact, cut.fact],
      have: [changes.id, cut.id, gone.id],
    });
    expect(new Set(corrections(answer).map((row) => JSON.stringify(row)))).toEqual(
      new Set(
        [
          { projection: changes.id, reason: "changed", current: replacement.id },
          { projection: cut.id, reason: "dropped", current: null },
          { projection: gone.id, reason: "withdrawn", current: null },
        ].map((row) => JSON.stringify(row)),
      ),
    );
    expect(removed(answer)).toEqual([changes.id, cut.id, gone.id].sort());
    const rows = new Map((await projectionsOf(db, one)).map((row) => [row.id, row]));
    expect(rows.get(changes.id)).toMatchObject({ reason: "changed", next_id: replacement.id });
    expect(rows.get(cut.id)).toMatchObject({ reason: "dropped", next_id: null });
    expect(rows.get(gone.id)).toMatchObject({ reason: "withdrawn", next_id: null });
    for (const id of [changes.id, cut.id, gone.id]) expect(rows.get(id)?.ended_at, id).not.toBeNull();
    expect(rows.get(replacement.id)).toMatchObject({ ended_at: null, reason: null });
  });

  it("with partial true, a live row not served and not open is dropped, never withdrawn", async () => {
    const one = await client();
    const entry = served(16);
    await serve(db, one.token, { entries: [entry] });
    const answer = await serve(db, one.token, { entries: [], open: [], partial: true });
    expect(corrections(answer)).toEqual([{ projection: entry.id, reason: "dropped", current: null }]);
    // The control: without partial the same row would have been withdrawn.
    const other = await client();
    await serve(db, other.token, { entries: [served(17)] });
    expect(corrections(await serve(db, other.token, { entries: [], open: [] }))).toEqual([
      { projection: served(17).id, reason: "withdrawn", current: null },
    ]);
  });

  it("an ended row served again is live, absent from corrections and from remove, with last_ended_at kept and reported_absent_at cleared", async () => {
    const one = await client();
    const entry = served(18);
    await serve(db, one.token, { entries: [entry], have: [] });
    // Reported present, then ended, then reported absent.
    await serve(db, one.token, { entries: [entry], have: [entry.id] });
    await serve(db, one.token, { entries: [], open: [], have: [entry.id] });
    await serve(db, one.token, { entries: [], open: [], have: [] });
    const ended = await projectionOf(db, entry.id);
    expect(ended.ended_at).not.toBeNull();
    expect(ended.reported_absent_at).not.toBeNull();
    const answer = await serve(db, one.token, { entries: [entry], have: [entry.id] });
    expect(corrections(answer)).toEqual([]);
    expect(removed(answer)).toEqual([]);
    const revived = await projectionOf(db, entry.id);
    expect(revived).toMatchObject({ ended_at: null, reason: null, next_id: null, reported_absent_at: null });
    expect(revived.last_ended_at).toEqual(ended.ended_at);
  });

  it("a tainted row served again is live, with last_tainted_at kept, and its exposure row stands", async () => {
    const one = await client();
    const entry = served(19);
    await serve(db, one.token, { entries: [entry] });
    expect(await taint(db, entry.evidence)).toBe(1);
    const tainted = await projectionOf(db, entry.id);
    expect(tainted.tainted_at).not.toBeNull();
    await serve(db, one.token, { entries: [{ ...entry, evidence: [evidenceId("19-again")] }] });
    const revived = await projectionOf(db, entry.id);
    expect(revived).toMatchObject({
      ended_at: null,
      reason: null,
      tainted_at: null,
      evidence_ids: [evidenceId("19-again")],
      belief_id: entry.belief,
    });
    expect(revived.last_tainted_at).toEqual(tainted.tainted_at);
    expect(
      await queryAs(db.urls.admin, "select projection_id, removal from ledger.memory_exposures where client_id = $1", [
        one.id,
      ]),
    ).toEqual([{ projection_id: entry.id, removal: "pending" }]);
  });

  it("remove holds an ended id, a tainted id, another client's id and an id never issued, and no live id", async () => {
    const one = await client();
    const other = await client();
    const [live, ended, tainted] = [served(20), served(21), served(22)];
    await serve(db, other.token, { entries: [served(23)] });
    await serve(db, one.token, { entries: [live, ended, tainted] });
    await serve(db, one.token, { entries: [live, tainted], open: [live.fact, tainted.fact] });
    await taint(db, tainted.evidence);
    const never = projectionId("never-issued");
    const answer = await serve(db, one.token, {
      entries: [live],
      have: [live.id, ended.id, tainted.id, served(23).id, never],
    });
    expect(removed(answer)).toEqual([ended.id, tainted.id, served(23).id, never].sort());
    // Another client's row is not touched by the report.
    expect((await projectionOf(db, served(23).id)).reported_present_at).toBeNull();
  });

  it("an id in have sets reported_present_at; one no longer in have sets reported_absent_at", async () => {
    const one = await client();
    const entry = served(24);
    await serve(db, one.token, { entries: [entry], have: [] });
    expect(await projectionOf(db, entry.id)).toMatchObject({ reported_present_at: null, reported_absent_at: null });
    await serve(db, one.token, { entries: [entry], have: [entry.id] });
    const present = await projectionOf(db, entry.id);
    expect(present.reported_present_at).not.toBeNull();
    expect(present.reported_absent_at).toBeNull();
    await serve(db, one.token, { entries: [entry], have: [] });
    expect((await projectionOf(db, entry.id)).reported_absent_at).not.toBeNull();
  });

  it("a second sync does not change reported_absent_at", async () => {
    const one = await client();
    const entry = served(25);
    await serve(db, one.token, { entries: [entry], have: [entry.id] });
    await serve(db, one.token, { entries: [], open: [], have: [] });
    const first = (await projectionOf(db, entry.id)).reported_absent_at;
    expect(first).not.toBeNull();
    await serve(db, one.token, { entries: [], open: [], have: [] });
    expect((await projectionOf(db, entry.id)).reported_absent_at).toEqual(first);
  });

  it("a row reported absent, then present again, then absent again takes the later absence", async () => {
    const one = await client();
    const entry = served(26);
    await serve(db, one.token, { entries: [entry], have: [entry.id] });
    await serve(db, one.token, { entries: [entry], have: [] });
    const firstAbsent = (await projectionOf(db, entry.id)).reported_absent_at;
    await serve(db, one.token, { entries: [entry], have: [entry.id] });
    const present = (await projectionOf(db, entry.id)).reported_present_at;
    expect(present?.getTime()).toBeGreaterThan(firstAbsent?.getTime() ?? Infinity);
    // Ended and gone from the file: the absence is after the last presence.
    await serve(db, one.token, { entries: [], open: [], have: [] });
    const ended = await projectionOf(db, entry.id);
    expect(ended.reported_absent_at?.getTime()).toBeGreaterThan(present?.getTime() ?? Infinity);
  });

  it("the corrections are the latest 20 ended rows of this client, by ended_at then id, with current_id the next_id", async () => {
    const one = await client();
    const other = await client();
    await serve(db, other.token, { entries: [served(399)] });
    await serve(db, other.token, { entries: [], open: [] });
    // Entry n is served alone in sync n, so sync n + 1 ends it withdrawn, each at its own time.
    for (let n = 300; n < 325; n += 1) await serve(db, one.token, { entries: [served(n)], open: [] });
    const answer = await serve(db, one.token, { entries: [], open: [] });
    expect(corrections(answer)).toEqual(
      Array.from({ length: 20 }, (_, n) => ({ projection: served(324 - n).id, reason: "withdrawn", current: null })),
    );
    // A changed row's correction names its next id.
    const changed = served(330);
    const next = served(331, { fact: changed.fact });
    await serve(db, one.token, { entries: [changed] });
    expect(corrections(await serve(db, one.token, { entries: [next] }))[0]).toEqual({
      projection: changed.id,
      reason: "changed",
      current: next.id,
    });
  });
});
