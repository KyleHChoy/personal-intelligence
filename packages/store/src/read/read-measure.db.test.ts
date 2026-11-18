import type { Claim } from "@intelligence/contracts";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipeline } from "../pipeline/pipeline.ts";
import { insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { session } from "../test-support/connections.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { createMeasure } from "./read-measure.ts";

// The query-time measurements, and beliefAt's timing in
// measure-beliefs: each measurement writes nothing. A statement trigger on every table of the
// store's schemas fails any insert, update or delete once the world is seeded; each measurement
// then runs as pi_pipeline and returns counts and milliseconds only.

const SCHEMAS = ["policy", "vault", "knowledge", "ledger", "projections", "queue"];

describe("the measurements write nothing", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let subject: string;
  let token: string;

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    subject = world.entityOf(WORLD.both.address);
    const messages = await worldMessages(store);
    const own = messages.filter((one) => one.compartment === "own");
    const on = (n: number): Message => own[n] as Message;

    // Two claims of one fact key whose sides differ only in wording, the later a third party's,
    // so the belief computed from them is disputed; and one plain claim with its belief.
    const record = (
      n: number,
      key: string,
      message: Message,
      title: string,
      basis: "explicit_self" | "third_party" = "explicit_self",
      at = message.sentAt,
    ): ClaimRecord => {
      const base = claimRecord(message.evidenceId, message.compartment, subject, {
        n,
        type: "role",
        factKey: key,
        validFrom: at,
        entities: [subject],
        basis,
      });
      return {
        ...base,
        claim: { ...base.claim, content: { ...base.claim.content, type: "role", fields: { title } } } as Claim,
        subjectKind: "person",
        fieldKinds: { title: "text" },
      } as ClaimRecord;
    };
    const a = record(1, "k-disputed", on(0), "General Partner", "explicit_self", daysFrom(WORLD_NOW, -6).toISOString());
    const b = record(2, "k-disputed", on(1), "general partner.", "third_party", daysFrom(WORLD_NOW, -5).toISOString());
    const c = record(3, "k-plain", on(2), "advisor");
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      for (const one of [a, b, c])
        expect(await pipeline.commit(batchOf(one.claim.primaryEvidenceId as never, [one]))).toBe("committed");
    } finally {
      await pipeline.close();
    }
    await knownBy(store.db, WORLD_NOW);

    // A project anchored to the thread of an own message.
    const [thread] = await session(store.db.urls.pipeline, (query) =>
      query<{ thread_fp: string }>("select thread_fp from knowledge.messages where evidence_id = $1", [
        on(0).evidenceId,
      ]),
    );
    await session(store.db.urls.admin, (query) =>
      seeder(store.db, query).projectAnchor(["own"], undefined, thread?.thread_fp),
    );
    // A client cleared for `own`, whose token get_entity's read path runs under.
    token = (
      await insertReader(store, "read-measure", ["own"], { tools: ["get_entity"], views: ["self", "people", "work"] })
    ).token;

    // From here, any write to any table of the store fails.
    await session(store.db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      await query(
        "create function knowledge.measure_no_write() returns trigger language plpgsql as $$ begin raise exception 'the measurement wrote to %', tg_table_name; end $$",
      );
      const tables = await query<{ name: string }>(
        `select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = any($1) and c.relkind in ('r', 'p') and not c.relispartition`,
        [SCHEMAS],
      );
      for (const { name } of tables)
        await query(
          `create trigger measure_no_write before insert or update or delete on ${name} for each statement execute function knowledge.measure_no_write()`,
        );
    });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store?.close();
  });

  const measuring = async <T>(
    fn: (measure: ReturnType<typeof createMeasure>) => Promise<T>,
    url = store.db.urls.pipeline,
  ): Promise<T> => {
    const measure = createMeasure({ url, keys: store.db.keys, log: recordingLogger().log });
    try {
      return await fn(measure);
    } finally {
      await measure.close();
    }
  };

  it("the trigger fails a write", async () => {
    await expect(
      session(store.db.urls.pipeline, (query) =>
        query("insert into knowledge.claims select * from knowledge.claims where false"),
      ),
    ).rejects.toThrow(/the measurement wrote/);
  });

  it("measure-beliefs times get_entity's card for the subjects with the most claims, and writes nothing", async () => {
    expect(
      await measuring((measure) => measure.beliefs("pit_test-unknown", { now: WORLD_NOW }), store.db.urls.reader),
    ).toBe("unauthorized");
    const result = await measuring(
      (measure) => measure.beliefs(token, { subjects: 50, now: WORLD_NOW }),
      store.db.urls.reader,
    );
    if (result === "unauthorized") throw new Error("the client's token was refused");
    expect(result.getEntity.subjects).toBeGreaterThan(0);
    expect(result.getEntity.notFound).toBe(0);
    expect(result.getEntity.count).toBe(result.getEntity.subjects);
    expect(result.getEntity.p99).toBeGreaterThanOrEqual(result.getEntity.p50);
    // beliefAt over every fact key the client sees, each alone and all at once.
    expect(result.beliefsFor.audienceCompartments).toBe(1);
    expect(result.beliefsFor.keys).toBeGreaterThanOrEqual(2);
    expect(result.beliefsFor.perKey.count).toBe(result.beliefsFor.keys);
    expect(result.beliefsFor.rows).toBeLessThanOrEqual(result.beliefsFor.keys);
    expect(result.beliefsFor.allMs).toBeGreaterThan(0);
  });

  // `about` with every area and with get_entity's, against 1 500 ms and 400 ms.
  it("measure-about times about for the subjects with the most claims, every area and get_entity's, and writes nothing", async () => {
    expect(
      await measuring((measure) => measure.about("pit_test-unknown", { now: WORLD_NOW }), store.db.urls.reader),
    ).toBe("unauthorized");
    const result = await measuring(
      (measure) => measure.about(token, { subjects: 50, now: WORLD_NOW }),
      store.db.urls.reader,
    );
    if (result === "unauthorized") throw new Error("the client's token was refused");
    expect(result.subjects).toBeGreaterThan(0);
    expect(result.all.count).toBe(result.subjects);
    expect(result.getEntityAreas.count).toBe(result.subjects);
    expect(result.refused).toBeLessThan(result.subjects);
    expect(result.all.p99).toBeGreaterThanOrEqual(result.all.p50);
    expect(result.all.overDeadline).toBeLessThanOrEqual(result.subjects);
  });

  it("measure-disputes counts disputed beliefs by kind and those that differ only in wording, and writes nothing", async () => {
    const result = await measuring((measure) => measure.disputes());
    expect(result.beliefs).toBe(2);
    expect(result.disputedByKind).toEqual({ role: 1 });
    expect(result.wordingOnlyByKind).toEqual({ role: 1 });
  });

  it("measure-projects times the links of the project with the most anchored items, and writes nothing", async () => {
    const result = await measuring((measure) => measure.projects({ runs: 5 }));
    expect(result.projects).toBe(1);
    expect(result.items).toBeGreaterThanOrEqual(1);
    expect(result.claims).toBeGreaterThanOrEqual(1);
    expect(result.ms.count).toBe(5);
  });
});
