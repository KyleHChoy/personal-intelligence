import { BELIEF_TYPES, KEY_FIELDS } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createDb } from "../core/job-db.ts";
import { type CommitmentSpec, commitClaims, worldMessages } from "../test-support/commitment-fixtures.ts";
import { session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore } from "../test-support/store.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { ownerBeliefs } from "./admin-owner.ts";

// The time of the owner's beliefs computed when asked, over the synthetic world grown to
// PI_MEASURE_FACTS commitment facts of two claims each and a tenth as many owner preferences: every
// belief (`pi extract status`), the stated types' (the self review), the owner-side kinds' (the
// cleanup) and the facts of the claims naming one person (a top person's, in the outcomes). A
// measurement, not a gate: skipped unless PI_MEASURE=1; it prints each read's runs.

const MEASURE = process.env.PI_MEASURE === "1";
const FACTS = Number(process.env.PI_MEASURE_FACTS ?? 2_000);
const RUNS = Number(process.env.PI_MEASURE_RUNS ?? 5);

describe.skipIf(!MEASURE)("the owner's every belief, computed when asked", () => {
  it("times ownerBeliefs over every fact key", { timeout: 3_600_000 }, async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const seed = await seedWorld(store.writer, store.admin);
      const owner = seed.ownerEntity();
      const others = [seed.entityOf(WORLD.both.address), seed.entityOf(WORLD.ownOnly.address)];
      const messages = await worldMessages(store);
      const specs: CommitmentSpec[] = Array.from({ length: FACTS }, (_, n) => ({
        key: `measure-${n}`,
        subject: n % 2 === 0 ? owner : (others[n % others.length] as string),
        counterparty: n % 2 === 0 ? (others[n % others.length] as string) : owner,
        claims: [0, 1].map((k) => ({
          message: messages[(n + k) % messages.length] as (typeof messages)[number],
          what: `measured step ${n}`,
        })),
      }));
      await commitClaims(store, owner, specs);
      // Preferences on items of their own: a commit replaces an item's claims.
      await session(store.db.urls.admin, async (query) => {
        const seed = seeder(store.db, query);
        for (let n = 0; n < FACTS / 10; n += 1) await seed.claim(["own"], undefined, "preference");
      });
      const named = (
        await queryAs<{ fact_key_fp: string }>(
          store.db.urls.admin,
          "select distinct c.fact_key_fp from knowledge.claim_entities n join knowledge.claims c on c.id = n.claim_id where n.entity_id = $1",
          [others[0]],
        )
      ).map((row) => row.fact_key_fp);
      const reads: [string, Parameters<typeof ownerBeliefs>[1]][] = [
        ["every belief", "all"],
        [
          "stated types",
          { types: BELIEF_TYPES.filter((type) => type !== "commitment" && !type.startsWith("project.")) },
        ],
        ["owner-side kinds", { types: Object.keys(KEY_FIELDS) }],
        ["one person's facts", named],
      ];
      const db = createDb(store.db.urls.admin, recordingLogger().log);
      const lines: string[] = [];
      let count = 0;
      try {
        for (const [name, keys] of reads) {
          const times: number[] = [];
          let n = 0;
          for (let run = 0; run < RUNS; run += 1) {
            const started = performance.now();
            n = (await db.transaction((query) => ownerBeliefs({ query, keys: store.db.keys }, keys))).length;
            times.push(Math.round(performance.now() - started));
          }
          count += n;
          const sorted = [...times].sort((a, b) => a - b);
          lines.push(
            `${name}: ${n} beliefs, runs ${times.join(", ")} ms, median ${sorted[Math.floor(sorted.length / 2)]} ms`,
          );
        }
      } finally {
        await db.close();
      }
      process.stdout.write(
        `ownerBeliefs over ${FACTS} commitment facts and ${FACTS / 10} preferences\n${lines.join("\n")}\n`,
      );
      expect(count).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  });
});
