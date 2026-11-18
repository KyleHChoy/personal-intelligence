import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Claim } from "@intelligence/contracts";
import { type ClaimRecord, EntityId, type ReadOutcome } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createPipeline } from "../pipeline/pipeline.ts";
import { insertReader, worldMessages } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore } from "../test-support/store.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, storeSeeder, WORLD, WORLD_NOW } from "../test-support/world.ts";

// Each read tool's time at a live size (about 4 800 claims of a belief type, 3 700 people), its
// beliefs computed at read under the caller's clearance, against its reply deadline
// (mcp/src/deadlines.ts).
//
// A measurement, not a gate: skipped unless PI_MEASURE=1 (tools/gate-manifest/manifest.ts,
// MEASUREMENTS).

const MEASURE = process.env.PI_MEASURE === "1";
const RUNS = Number(process.env.PI_MEASURE_RUNS ?? 20);
const PEOPLE = Number(process.env.PI_MEASURE_PEOPLE ?? 3_700);
const BELIEVED = Number(process.env.PI_MEASURE_BELIEVED ?? 1_600);

const OWN = ["own"];
const TOOLS = ["get_self", "get_entity", "find_facts", "build_context_pack", "get_commitments", "get_beliefs"];
const VIEWS = ["self", "people", "work"];

// Deadlines in mcp/src/deadlines.ts: get_entity and get_self measured, get_beliefs and
// get_commitments the whole-store tier.
const DEADLINES = { get_entity: 800, get_self: 4_500, get_beliefs: 1_500, get_commitments: 1_500 } as const;
const percentile = (sorted: number[], p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;

describe.skipIf(!MEASURE)("each tool's time at a live size", () => {
  it("times get_entity, get_self, get_beliefs and get_commitments", {
    timeout: 4 * 3_600_000,
  }, async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedWorld(store.writer, store.admin, { labels: ["personal"] });
      const owner = world.ownerEntity();
      const seed = storeSeeder(store.writer, WORLD_NOW);
      const mailbox = await store.writer.ensureSourceAccount("personal", "google_mail", "own", WORLD.ownerPersonal);
      const address = (n: number): string => `person-${n}@measure-personal.test`;
      for (let n = 0; n < PEOPLE; n += 1)
        await seed.mail(mailbox, {
          id: `measure-${n}`,
          from: { address: address(n), name: `Measure Person${n}` },
          to: [{ address: WORLD.ownerPersonal }],
          at: new Date(WORLD_NOW.getTime() - (n + 1) * 3_600_000),
          subject: `canary-measure-${n}`,
        });
      const evidence = new Map((await worldMessages(store)).map((one) => [one.sentAt, one.evidenceId] as const));
      // Three claims about each of the first BELIEVED people: a role, a commitment either way, and
      // a need, a capability or a tie to the person before; every sixteenth third claim is the
      // owner's goal instead.
      const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
      let claims = 0;
      try {
        for (let n = 0; n < BELIEVED; n += 1) {
          const person = seed.entityOf(address(n));
          const sentAt = new Date(WORLD_NOW.getTime() - (n + 1) * 3_600_000).toISOString();
          const item = evidence.get(sentAt) as string;
          const make = (
            k: number,
            type: string,
            subject: string,
            fields: Record<string, unknown>,
            kinds: Record<string, string>,
            entities: string[],
          ): ClaimRecord => {
            const base = claimRecord(item, "own", subject, {
              n: k,
              type,
              factKey: `m-${n}-${k}`,
              validFrom: sentAt,
              entities,
            });
            return {
              ...base,
              claim: { ...base.claim, assertedBy: subject, content: { ...base.claim.content, type, fields } } as Claim,
              subjectKind: subject === owner ? "owner" : "person",
              fieldKinds: kinds,
            } as ClaimRecord;
          };
          const previous = n === 0 ? person : seed.entityOf(address(n - 1));
          const third =
            n % 16 === 0
              ? make(3, "goal", owner, { what: `canary-goal-${n}` }, { what: "text" }, [])
              : n % 3 === 0
                ? make(3, "need", person, { what: `canary-need-${n}` }, { what: "text" }, [person])
                : n % 3 === 1
                  ? make(3, "capability", person, { what: `canary-cap-${n}` }, { what: "text" }, [person])
                  : make(
                      3,
                      "relationship",
                      person,
                      { counterparty: previous, relation: "friend" },
                      { counterparty: "entity", relation: "enum" },
                      [person, previous],
                    );
          const owes = n % 2 === 0;
          const batch = [
            make(1, "role", person, { title: `canary-title-${n}` }, { title: "text" }, [person]),
            make(
              2,
              "commitment",
              owes ? owner : person,
              {
                counterparty: owes ? person : owner,
                what: `canary-commit-${n}`,
                ...(n % 5 === 0 ? { due: "2026-03-20" } : {}),
              },
              { counterparty: "entity", what: "text", due: "date" },
              [person],
            ),
            third,
          ];
          expect(await pipeline.commit(batchOf(item as never, batch))).toBe("committed");
          claims += batch.length;
        }
      } finally {
        await pipeline.close();
      }
      await knownBy(store.db, WORLD_NOW);
      const client = await insertReader(store, "measure-reads", OWN, { tools: TOOLS, views: VIEWS });
      // The read budget would stop the runs: the measuring client's is the widest the table allows.
      await queryAs(
        store.db.urls.admin,
        "update policy.clients set max_calls_minute = 600, max_rows_day = 1000000 where id = $1",
        [client.id],
      );
      const someone = EntityId.parse(seed.entityOf(address(1)));
      const calls: Record<keyof typeof DEADLINES, () => Promise<ReadOutcome<unknown>>> = {
        get_entity: () => store.reader.getEntity(client.token, { id: someone }),
        get_self: () => store.reader.getSelf(client.token),
        get_beliefs: () => store.reader.getBeliefs(client.token, { state: "any" }),
        get_commitments: () => store.reader.getCommitments(client.token, {}),
      };
      const results: Record<string, unknown> = { people: PEOPLE, claims, runs: RUNS };
      for (const [tool, call] of Object.entries(calls)) {
        const samples: number[] = [];
        for (let run = 0; run < RUNS; run += 1) {
          const start = performance.now();
          outcomeValue(await call());
          samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        results[tool] = {
          p50: Math.round(percentile(samples, 0.5)),
          p95: Math.round(percentile(samples, 0.95)),
          max: Math.round(samples.at(-1) ?? 0),
          deadline: DEADLINES[tool as keyof typeof DEADLINES],
        };
      }
      const file = join(tmpdir(), "computed-beliefs-measure.json");
      await writeFile(file, `${JSON.stringify(results, null, 2)}\n`);
      console.info(JSON.stringify(results));
      expect(claims).toBe(3 * BELIEVED);
    } finally {
      await store.close();
    }
  });
});
