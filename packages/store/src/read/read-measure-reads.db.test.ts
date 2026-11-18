import type { Claim } from "@intelligence/contracts";
import type { ClaimRecord, EntityId } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipeline } from "../pipeline/pipeline.ts";
import { insertReader, worldMessages } from "../test-support/commitment-fixtures.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { createReader } from "./read.ts";
import { createMeasure, type ReadMeasure } from "./read-measure.ts";

// Read performance (`pia extract measure-reads`): get_entity's, get_self's, search's and find_paths'
// store read paths, timed statement by statement, as pi_reader under a client's token, on the
// synthetic world. It writes no row, the read log and the call log among them, and its output
// names no one.

const SCHEMAS = ["policy", "ledger"];

describe("measure-reads", { timeout: DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let token: string;
  let subject: string;

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    subject = world.entityOf(WORLD.both.address);
    // Claims about two people, so the subjects with the most claims are found: three role claims
    // about Blake, from own and work mail, and one about Wren.
    const messages = await worldMessages(store);
    const about = (
      n: number,
      pick: number,
      entity: string,
      compartment: string,
      title: string,
      also: string[] = [],
    ): ClaimRecord => {
      const message = messages.filter((one) => one.compartment === compartment)[pick];
      if (message === undefined) throw new Error("the world has too few messages");
      const base = claimRecord(message.evidenceId, message.compartment, entity, {
        n,
        type: "role",
        factKey: `k-role-${entity}`,
        validFrom: message.sentAt,
        entities: [entity, ...also],
      });
      return {
        ...base,
        claim: { ...base.claim, content: { ...base.claim.content, type: "role", fields: { title } } } as Claim,
        subjectKind: "person",
        fieldKinds: { title: "text" },
      } as ClaimRecord;
    };
    const wren = world.entityOf(WORLD.workOnly.address);
    // The organization the world's mail minted, named by Wren's role claim, so --explain plans
    // find_facts for it.
    const [organization] = await queryAs<{ entity_id: string }>(
      store.db.urls.admin,
      "select entity_id from knowledge.domains where domain_fp = $1",
      [fingerprint(store.db.keys, "domain", "example.org")],
    );
    if (organization === undefined) throw new Error("the world minted no organization");
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      for (const one of [
        about(1, 0, subject, "own", "advisor"),
        about(2, 1, subject, "own", "partner"),
        about(3, 0, subject, "employer:example", "partner"),
        about(4, 1, wren, "employer:example", "engineer", [organization.entity_id]),
      ]) {
        expect(await pipeline.commit(batchOf(one.claim.primaryEvidenceId as never, [one]))).toBe("committed");
      }
    } finally {
      await pipeline.close();
    }
    // Cleared for both labels, with every view the three tools read under.
    token = (
      await insertReader(store, "measure-reads", ["own", "employer:example"], {
        tools: ["get_entity", "get_self", "search"],
        views: ["self", "people", "work"],
      })
    ).token;
  }, DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store?.close();
  });

  // Every row of every table of the policy and ledger schemas pi_admin can read: the call log
  // (policy.calls), the read log (ledger.read_log), the sessions and the rest.
  const counts = async (): Promise<Record<string, number>> => {
    const tables = await queryAs<{ name: string }>(
      store.db.urls.admin,
      `select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any($1) and c.relkind in ('r', 'p') and not c.relispartition and has_table_privilege(c.oid, 'select')
       order by 1`,
      [SCHEMAS],
    );
    const out: Record<string, number> = {};
    for (const { name } of tables)
      out[name] = Number(
        (await queryAs<{ n: string }>(store.db.urls.admin, `select count(*) as n from ${name}`))[0]?.n,
      );
    return out;
  };

  const measuring = async <T>(fn: (measure: ReturnType<typeof createMeasure>) => Promise<T>): Promise<T> => {
    const measure = createMeasure({ url: store.db.urls.reader, keys: store.db.keys, log: recordingLogger().log });
    try {
      return await fn(measure);
    } finally {
      await measure.close();
    }
  };

  it("refuses a token with no client", async () => {
    expect(await measuring((measure) => measure.reads("pit_test-unknown", { now: WORLD_NOW }))).toBe("unauthorized");
  });

  it("times each tool's read path by statement, writes no row, and names no one", async () => {
    const before = await counts();
    expect(Object.keys(before)).toEqual(expect.arrayContaining(["ledger.read_log", "ledger.sessions", "policy.calls"]));
    const result = await measuring((measure) => measure.reads(token, { now: WORLD_NOW }));
    if (result === "unauthorized") throw new Error("the client's token was refused");
    expect(await counts()).toEqual(before);

    expect(result.subjects).toBeGreaterThan(0);
    expect(Object.keys(result.tools).sort()).toEqual(["find_paths", "get_entity", "get_self", "search"]);
    const expectShape = (tool: ReadMeasure, n: number): void => {
      expect(Object.keys(tool).sort()).toEqual(["max", "n", "otherMs", "p50", "p95", "statements"]);
      expect(tool.n).toBe(n);
      expect(tool.p50).toBeLessThanOrEqual(tool.p95);
      expect(tool.p95).toBeLessThanOrEqual(tool.max);
      expect(tool.otherMs).toBeGreaterThanOrEqual(0);
      expect(tool.statements.length).toBeGreaterThan(0);
      expect(tool.statements.length).toBeLessThanOrEqual(10);
      for (const one of tool.statements) {
        expect(Object.keys(one).sort()).toEqual(["calls", "id", "p95Ms", "totalMs", "words"]);
        expect(one.id).toMatch(/^[0-9a-f]{8}$/);
        expect(one.words.split(" ").length).toBeLessThanOrEqual(6);
        expect(one.calls).toBeGreaterThan(0);
      }
      const totals = tool.statements.map((one) => one.totalMs);
      expect(totals).toEqual([...totals].sort((a, b) => b - a));
    };
    expectShape(result.tools.get_entity, result.subjects);
    expectShape(result.tools.get_self, 10);
    expectShape(result.tools.search, result.subjects);
    expectShape(result.tools.find_paths, result.subjects);

    // No name, address, subject line or meeting title of the world, in any string of the output.
    const printed = JSON.stringify(result).toLowerCase();
    const needles = [
      WORLD.ownerPersonal,
      WORLD.ownerWork,
      WORLD.both.address,
      WORLD.both.ownName,
      WORLD.both.workName,
      WORLD.workOnly.address,
      WORLD.workOnly.name,
      WORLD.ownOnly.address,
      WORLD.ownOnly.name,
      ...Object.values(WORLD.ownSubjects),
      WORLD.ownMeeting,
      WORLD.workMeetingNext,
      WORLD.workMeetingLast,
      "canary",
      "example.com",
      "example.org",
    ];
    for (const needle of needles) expect(printed).not.toContain(needle.toLowerCase());
  });

  it("--explain adds the rulings statement's plan and find_facts' for an organization, run under the token, writing no row and naming no one", async () => {
    const before = await counts();
    const result = await measuring((measure) => measure.reads(token, { now: WORLD_NOW, subjects: 3, explain: true }));
    if (result === "unauthorized") throw new Error("the client's token was refused");
    expect(await counts()).toEqual(before);
    const plan = result.plans?.rulings as { Plan?: { "Node Type"?: string; "Actual Rows"?: number } }[];
    expect(Array.isArray(plan)).toBe(true);
    expect(plan[0]?.Plan?.["Node Type"]).toBeTypeOf("string");
    expect(plan[0]?.Plan?.["Actual Rows"]).toBeTypeOf("number");
    const facts = result.plans?.facts as { Plan?: { "Node Type"?: string; "Actual Rows"?: number } }[];
    expect(Array.isArray(facts)).toBe(true);
    expect(facts[0]?.Plan?.["Actual Rows"]).toBe(1);
    // The token's keys: within its two-compartment clearance, so at least its own key and at most
    // the three labels of those two compartments.
    const names = result.plans?.names as { Plan?: { "Node Type"?: string } }[];
    expect(names[0]?.Plan?.["Node Type"]).toEqual(expect.any(String));
    const keys = result.plans?.keys;
    expect(keys?.compartments).toBe(2);
    expect(keys?.keys).toBeGreaterThanOrEqual(1);
    expect(keys?.keys).toBeLessThanOrEqual(3);
    // The labels table's size, from the catalog: every label the world wrote is a live row.
    expect(keys?.labels?.live).toBeGreaterThanOrEqual(1);
    expect(keys?.labels?.dead).toBeGreaterThanOrEqual(0);
    for (const plan of [keys?.plans.clearanceKeys, keys?.plans.clientClearance, keys?.plans.clientKind])
      expect((plan as { Plan?: { "Node Type"?: string } }[])[0]?.Plan?.["Node Type"]).toBe("Result");
    const printed = JSON.stringify(result.plans).toLowerCase();
    for (const needle of [WORLD.ownerPersonal, WORLD.both.address, WORLD.both.ownName, WORLD.ownOnly.name, token])
      expect(printed).not.toContain(needle.toLowerCase());
    // Without the flag, no plan.
    const plain = await measuring((measure) => measure.reads(token, { now: WORLD_NOW, subjects: 1 }));
    expect(plain === "unauthorized" ? null : plain.plans).toBeUndefined();
  });

  // The control: the same token through the Reader's own call path does write the call log and
  // the read log, so the counts above would have seen a write.
  it("the counts see the rows a real call writes", async () => {
    const before = await counts();
    const reader = createReader({
      url: store.db.urls.reader,
      keys: store.db.keys,
      log: recordingLogger().log,
      now: () => WORLD_NOW,
    });
    try {
      expect((await reader.getEntity(token, { id: subject as EntityId })).ok).toBe(true);
    } finally {
      await reader.close();
    }
    const after = await counts();
    expect(after["policy.calls"]).toBeGreaterThan(before["policy.calls"] ?? 0);
    expect(after["ledger.read_log"]).toBeGreaterThan(before["ledger.read_log"] ?? 0);
  });
});
