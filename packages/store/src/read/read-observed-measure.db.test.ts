import { type EntityId, PathList } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { insertReader } from "../test-support/commitment-fixtures.ts";
import { session } from "../test-support/connections.ts";
import { queryAs, sealRow } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore } from "../test-support/store.ts";
import { interactionId, outcomeValue } from "../test-support/values.ts";
import { warmthWorld } from "../test-support/warmth-fixtures.ts";
import { seedWorld, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";
import {
  FRONTIER_MOST,
  LAYER_ROWS_MOST,
  MEETING_MAX_PEOPLE,
  OBSERVED_STATEMENTS,
  THREAD_MAX_PEOPLE,
} from "./read-observed.ts";
import { OWN_TIES } from "./read-paths.ts";

// A measurement, not a gate: skipped unless PI_MEASURE=1, run on the build machine, and its numbers go into
// the decision. It is run again when these statements change.
//
// 100,000 messages among 20,000 people under `own` and the same again under `employer:example`, a
// third of them bulk, as the store files bulk mail: no interaction rows. Its worst cases are built on
// purpose: people on 8,000 messages each, a list-like thread of 500 people, and a target whose
// neighbours overflow one layer. Rows are written straight into the tables, not through the writer,
// which would take hours.

const MEASURE = process.env.PI_MEASURE === "1";
const MESSAGES = Number(process.env.PI_MEASURE_MESSAGES ?? 100_000);
const PEOPLE = Number(process.env.PI_MEASURE_PEOPLE ?? 20_000);
const RUNS = Number(process.env.PI_MEASURE_RUNS ?? 40);
const MEETINGS = Number(process.env.PI_MEASURE_MEETINGS ?? 1_000);
// One message in this many is one the owner sent, to its people; none by default. The owner's own
// mail is the outbound side of OWN_TIES, so a store that has much of it is that read's worst case.
const SENT_EVERY = Number(process.env.PI_MEASURE_SENT_EVERY ?? 0);
const BATCH = 2_000;
const FIND_PATHS_DEADLINE_MS = 1_500;
const OWN = ["own"];
const EMPLOYER = ["employer:example"];

const percentile = (sorted: number[], p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;

describe.skipIf(!MEASURE)("find_paths with observed hops at the reference size", () => {
  it("stays within its deadline on its worst targets", { timeout: 3_600_000 }, async () => {
    const store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example"] });
    try {
      await seedWorld(store.writer, store.admin);
      const { keys } = store.db;
      const world = warmthWorld(store.db);
      const fp = (kind: Parameters<typeof fingerprint>[1], value: string): string => fingerprint(keys, kind, value);

      type Grown = { people: string[]; hubs: string[]; ownTied: string[] };
      const grow = (label: string[], tag: string): Promise<Grown> =>
        session(store.db.urls.admin, async (query) => {
          const seed = seeder(store.db, query);
          const compartment = label[0] as string;
          const accountId = await seed.sourceAccount(label);

          const people: string[] = [];
          for (let start = 0; start < PEOPLE; start += BATCH) {
            const ids = Array.from({ length: Math.min(BATCH, PEOPLE - start) }, () => testId("ent"));
            await query("insert into knowledge.entities (id, kind) select x, 'person' from unnest($1::text[]) as x", [
              ids,
            ]);
            const rows = ids.map((entity, n) => {
              const id = testId("adr");
              const domain = `measure-${tag}-${(start + n) % 2_000}.test`;
              const address = `person-${start + n}@${domain}`;
              return {
                id,
                entity,
                value: fp("address", `${tag}-${address}`),
                domain: fp("domain", domain),
                sealed: sealRow(keys, compartment, { table: "knowledge.accounts", id, column: "value_enc" }, address),
              };
            });
            await query(
              `insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, compartments, value_enc)
               select r.id, r.entity_id, 'email', r.value_fp, r.domain_fp, $6::text[], r.value_enc::jsonb
               from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) as r (id, entity_id, value_fp, domain_fp, value_enc)`,
              [
                rows.map((r) => r.id),
                rows.map((r) => r.entity),
                rows.map((r) => r.value),
                rows.map((r) => r.domain),
                rows.map((r) => JSON.stringify(r.sealed)),
                label,
              ],
            );
            people.push(...ids);
          }
          // An organization on every 2,000th of those domains, and so about ten people each.
          const domains = Array.from({ length: 2_000 }, (_, n) => `measure-${tag}-${n}.test`);
          const organizations = domains.map(() => testId("ent"));
          await query(
            "insert into knowledge.entities (id, kind) select x, 'organization' from unnest($1::text[]) as x",
            [organizations],
          );
          const domainRows = domains.map((domain, n) => {
            const id = testId("dom");
            return {
              id,
              fp: fp("domain", domain),
              entity: organizations[n] as string,
              sealed: JSON.stringify(
                sealRow(keys, compartment, { table: "knowledge.domains", id, column: "domain_enc" }, domain),
              ),
            };
          });
          await query(
            `insert into knowledge.domains (id, domain_fp, entity_id, domain_enc, compartments)
             select r.id, r.fp, r.entity, r.sealed::jsonb, $5::text[]
             from unnest($1::text[], $2::text[], $3::text[], $4::text[]) as r (id, fp, entity, sealed)`,
            [
              domainRows.map((r) => r.id),
              domainRows.map((r) => r.fp),
              domainRows.map((r) => r.entity),
              domainRows.map((r) => r.sealed),
              label,
            ],
          );

          const hubs = people.slice(0, FRONTIER_MOST * 2);
          const list = people.slice(1_000, 1_500);
          const someone = (n: number): string => people[(n * 7_919) % people.length] as string;
          const peerRows: { evidence: string; entity: string; role: string; direction: string; at: string }[] = [];
          for (let start = 0; start < MESSAGES; start += BATCH) {
            const count = Math.min(BATCH, MESSAGES - start);
            const rows = Array.from({ length: count }, (_, i) => {
              const n = start + i;
              const sourceItem = `measure-${tag}-${n}`;
              const evidence = sha256Hex(sourceItem);
              const id = testId("msg");
              const at = new Date(WORLD_NOW.getTime() - (n + 1) * 60_000).toISOString();
              const bulk = n % 3 === 0;
              const crowded = n % 100 === 1;
              const sent = SENT_EVERY > 0 && !bulk && n % SENT_EVERY === 2;
              const thread = crowded ? `${tag}-list` : `${tag}-thread-${Math.floor(n / 3)}`;
              if (!bulk) {
                // People on one message: a hub on one in four, the rest spread out.
                const sender = n % 4 === 1 ? (hubs[n % hubs.length] as string) : someone(n);
                const others = crowded
                  ? list.slice(n % 400, (n % 400) + THREAD_MAX_PEOPLE + 5)
                  : [someone(n + 1), someone(n + 2)];
                for (const entity of new Set([sender, ...others]))
                  peerRows.push({
                    evidence,
                    entity,
                    role: !sent && entity === sender ? "sender" : "recipient",
                    direction: sent ? "outbound" : "inbound",
                    at,
                  });
              }
              return { evidence, id, at, bulk, sourceItem, thread };
            });
            await query(
              `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, next_revision_id,
                 content_hash, media_type, observed_at, change_kind, participant_members, system_originated, answers_system, payload_state,
                 compartments, readers, blob_ref, item_enc)
               select r.id, $4, 'email', r.fp, r.fp, 0, r.id || '-next', r.fp, 'message/rfc822', r.at::timestamptz, 'backfill', '{m-owner}', false, false,
                 'expired', $5::text[], '{m-owner}', null, $6::jsonb
               from unnest($1::text[], $2::text[], $3::text[]) as r (id, fp, at)`,
              [
                rows.map((r) => r.evidence),
                rows.map((r) => fp("source_id", r.sourceItem)),
                rows.map((r) => r.at),
                accountId,
                label,
                JSON.stringify(
                  sealRow(keys, compartment, { table: "vault.evidence_items", id: "e", column: "item_enc" }, "{}"),
                ),
              ],
            );
            const sealed = JSON.stringify(
              sealRow(keys, compartment, { table: "knowledge.messages", id: "m", column: "facts_enc" }, "{}"),
            );
            await query(
              `insert into knowledge.messages (id, evidence_id, sent_at, direction, bulk, category, held, thread_fp, compartments, facts_enc)
               select r.id, r.evidence, r.at::timestamptz, 'inbound', r.bulk, case when r.bulk then 'updates' else 'primary' end, false, r.thread, $6::text[], $7::jsonb
               from unnest($1::text[], $2::text[], $3::text[], $4::boolean[], $5::text[]) as r (id, evidence, at, bulk, thread)`,
              [
                rows.map((r) => r.id),
                rows.map((r) => r.evidence),
                rows.map((r) => r.at),
                rows.map((r) => r.bulk),
                rows.map((r) => fp("thread", r.thread)),
                label,
                sealed,
              ],
            );
            const flush = peerRows.splice(0);
            for (let at = 0; at < flush.length; at += BATCH) {
              const part = flush.slice(at, at + BATCH);
              await query(
                `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, entity_role, compartments, readers)
                 select r.id, r.evidence, 'm-owner', r.entity, r.direction, 'email', r.at::timestamptz, r.role, $6::text[], '{m-owner}'
                 from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $7::text[]) as r (id, evidence, entity, at, role, direction)`,
                [
                  part.map((r) => interactionId(r.evidence, r.entity)),
                  part.map((r) => r.evidence),
                  part.map((r) => r.entity),
                  part.map((r) => r.at),
                  part.map((r) => r.role),
                  label,
                  part.map((r) => r.direction),
                ],
              );
            }
          }
          await query("analyze");
          return { people, hubs, ownTied: people.slice(PEOPLE / 2, PEOPLE / 2 + 50) };
        });

      const own = await grow(OWN, "own");
      await grow(EMPLOYER, "work");
      // Meetings the owner declined, on the people with the most mail.
      for (let n = 0; n < MEETINGS; n += 1)
        await world.meeting(
          OWN,
          [
            ...new Set([
              own.hubs[n % own.hubs.length] as string,
              own.people[(n * 7_919 + 1) % PEOPLE] as string,
              own.people[(n * 104_729 + 2) % PEOPLE] as string,
            ]),
          ],
          new Date(WORLD_NOW.getTime() - (n + 1) * 3_600_000).toISOString(),
          { response: "declined" },
        );
      await queryAs(store.db.urls.admin, "analyze");
      for (const person of own.ownTied) {
        await world.mail(OWN, { at: WORLD_NOW.toISOString(), to: [person] });
        await world.mail(OWN, { at: WORLD_NOW.toISOString(), from: person });
      }
      const client = await insertReader(store, "measure-observed", OWN, {
        tools: ["find_paths"],
        views: ["self", "people", "work"],
      });
      const reader = new Reader({ pool: store.readerPool, keys, log: store.log, now: () => store.now });

      const targets: Record<string, string> = {
        // On thousands of messages, and those people on thousands more.
        hub: own.hubs[0] as string,
        // On the crowded list thread alone.
        list: own.people[1_200] as string,
        ordinary: own.people[PEOPLE - 1] as string,
        // Someone the owner has a tie with: no observed read runs, so this is the stated read alone.
        baseline: own.ownTied[0] as string,
      };
      const report: Record<string, unknown> = {};
      for (const [name, target] of Object.entries(targets)) {
        const times: number[] = [];
        let cut = false;
        let found = 0;
        for (let n = 0; n < RUNS; n += 1) {
          const started = performance.now();
          const list = PathList.parse(
            outcomeValue(await reader.findPaths(client.token, { target: target as EntityId })),
          );
          times.push(performance.now() - started);
          cut ||= list.cut;
          found = list.paths.length;
        }
        times.sort((a, b) => a - b);
        report[name] = {
          p50: Math.round(percentile(times, 0.5)),
          p99: Math.round(percentile(times, 0.99)),
          cut,
          found,
        };
      }

      // Each statement's plan on the worst seeds, as the reader runs it under the client's own policies.
      const seeds = own.hubs.slice(0, FRONTIER_MOST);
      const plan = await store.readerPool.connect();
      try {
        await plan.query("begin");
        await plan.query("select set_config('pi.client_token', $1, true), set_config('enable_seqscan', 'off', true)", [
          client.token,
        ]);
        for (const [name, statement, values] of [
          ["own_ties", OWN_TIES, [WORLD_NOW.toISOString()]],
          [
            "thread",
            OBSERVED_STATEMENTS.THREAD_PEERS,
            [seeds, LAYER_ROWS_MOST, THREAD_MAX_PEOPLE, null, WORLD_NOW.toISOString(), []],
          ],
          [
            "meeting",
            OBSERVED_STATEMENTS.MEETING_PEERS,
            [seeds, LAYER_ROWS_MOST, MEETING_MAX_PEOPLE, null, WORLD_NOW.toISOString(), []],
          ],
          ["domain", OBSERVED_STATEMENTS.DOMAIN_PEOPLE, [seeds, 100, [], null, [], WORLD_NOW.toISOString()]],
        ] as const) {
          const rows = await plan.query(`explain (analyze, buffers) ${statement}`, [...values]);
          const lines = rows.rows.map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"]);
          report[`plan_${name}`] =
            process.env.PI_MEASURE_PLANS === "1"
              ? lines
              : lines.filter((line: string) => /Seq Scan|Execution Time/.test(line));
        }
        await plan.query("rollback");
      } finally {
        plan.release();
      }
      process.stderr.write(`${JSON.stringify(report, null, 1)}\n`);
      // The read's cost before this feature is the baseline's; what must fit is what it adds.
      const median = (name: string): number => (report[name] as { p50: number }).p50;
      for (const name of Object.keys(targets))
        expect(median(name) - median("baseline")).toBeLessThan(FIND_PATHS_DEADLINE_MS);
    } finally {
      await store.close();
    }
  });
});
