import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import type { EntityId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Query } from "../core/db.ts";
import { createDb } from "../core/job-db.ts";
import { groupsFromRows } from "../read/read-groups.ts";
import { insertClient, sha256Hex, testId } from "../test-support/clients.ts";
import { readAs, session } from "../test-support/connections.ts";
import { fingerprint, sealRow } from "../test-support/database.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore } from "../test-support/store.ts";
import { interactionId } from "../test-support/values.ts";
import { computeWarmth } from "./warmth-build.ts";
import { buildDueDays, clearWarmthMemo, rankWarmth } from "./warmth-days.ts";

// The whole warmth ranking of one clearance computed on demand, timed at the live
// size, for the reply deadlines (mcp/src/deadlines.ts). A measurement, not a gate: skipped unless
// PI_MEASURE=1. The world is grown in bulk SQL (as pi_admin, and the chat lines as pi_writer, under `own`) to the box's size:
// PEOPLE people with one address each, MAIL mail evidence items (a fifth read by their headers
// alone, a tenth with a second person beside), MEETINGS meetings of two to four people, and CHAT
// chat lines among the closest CHATTERS. Contacts fall on a few people heavily and on most once
// or twice, over five years.

const MEASURE = process.env.PI_MEASURE === "1";
const PEOPLE = Number(process.env.PI_MEASURE_PEOPLE ?? 3_700);
const MAIL = Number(process.env.PI_MEASURE_MAIL ?? 24_000);
const MEETINGS = Number(process.env.PI_MEASURE_MEETINGS ?? 1_500);
const CHAT = Number(process.env.PI_MEASURE_CHAT ?? 20_000);
const CHATTERS = 150;
const RUNS = Number(process.env.PI_MEASURE_RUNS ?? 10);
const TODAY = new Date("2026-11-17T12:00:00.000Z");
const SPAN_MS = 5 * 365 * 86_400_000;
const OWN = ["own"];
const BATCH = 5_000;

// A fixed sequence, so every run grows the same world.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const chatLineId = (n: number): string =>
  `chl_${[...n.toString(32).padStart(26, "0")].map((digit) => CROCKFORD[Number.parseInt(digit, 32)]).join("")}`;

async function inBatches<T>(rows: readonly T[], fn: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let start = 0; start < rows.length; start += BATCH) await fn(rows.slice(start, start + BATCH));
}

const percentile = (sorted: number[], p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;

describe.skipIf(!MEASURE)("the warmth ranking computed on demand at the live size", () => {
  it("times computeWarmth for the owner's clearance", { timeout: 3_600_000 }, async () => {
    const store = await openStore({ now: TODAY });
    const db = store.db;
    try {
      const next = random(20_261_117);
      const pick = (): number => Math.min(PEOPLE - 1, Math.floor(PEOPLE * next() ** 2.5));
      const at = (): Date => new Date(TODAY.getTime() - Math.floor(next() * SPAN_MS));

      // Template rows, each copied for its fixed columns. The mail's payloads are expired, so no blob is shared.
      const template = await session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        const account = await seed.sourceAccount(OWN);
        const evidence = await seed.evidence(OWN, account);
        const message = await seed.message(OWN, evidence);
        const event = await seed.event(OWN, evidence);
        await seed.eventDetails(OWN, event, account);
        return { account, evidence, message, event };
      });

      // Each sealed column sealed for its own row, so a read that opens one opens it.
      const sealed = (table: string, id: string, column: string, value: string): string =>
        JSON.stringify(sealRow(db.keys, "own", { table, id, column }, value));
      const seededAt = performance.now();
      await session(db.urls.admin, async (query: Query) => {
        // People, each with one sealed address the computation opens.
        const people = Array.from({ length: PEOPLE }, (_, n) => {
          const id = testId("ent");
          const account = testId("adr");
          const address = `measure-${n}@measure-people.test`;
          return {
            id,
            account,
            fp: fingerprint(db.keys, "address", address),
            domain: fingerprint(db.keys, "domain", "measure-people.test"),
            sealed: JSON.stringify(
              sealRow(db.keys, "own", { table: "knowledge.accounts", id: account, column: "value_enc" }, address),
            ),
          };
        });
        await inBatches(people, async (batch) => {
          await query("insert into knowledge.entities (id, kind) select unnest($1::text[]), 'person'", [
            batch.map((one) => one.id),
          ]);
          await query(
            `insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, compartments, value_enc)
             select u.id, u.entity, 'email', u.fp, u.domain, '{own}', u.sealed::jsonb
             from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) as u (id, entity, fp, domain, sealed)`,
            [
              batch.map((one) => one.account),
              batch.map((one) => one.id),
              batch.map((one) => one.fp),
              batch.map((one) => one.domain),
              batch.map((one) => one.sealed),
            ],
          );
        });

        // Mail: evidence, a message unless read by headers alone, and its interaction rows.
        const mail = Array.from({ length: MAIL }, (_, n) => {
          const person = pick();
          const item = `measure-mail-${n}`;
          const where = { vault: "personal" as const, sourceAccount: template.account, sourceItemId: item };
          return {
            id: evidenceIdFor({ ...where, revision: 0 }),
            nextId: evidenceIdFor({ ...where, revision: 1 }),
            itemFp: sha256Hex(`item ${n}`),
            tagFp: sha256Hex(`tag ${n}`),
            hash: sha256Hex(`hash ${n}`),
            thread: sha256Hex(`thread ${person} ${Math.floor(n / 6)}`),
            headers: next() < 0.2,
            message: testId("msg"),
            at: at().toISOString(),
            out: next() < 0.5,
            people: next() < 0.1 ? [person, pick()].filter((one, i, all) => all.indexOf(one) === i) : [person],
          };
        });
        await inBatches(mail, async (batch) => {
          await query(
            `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, next_revision_id,
               thread_fp, content_hash, media_type, observed_at, change_kind, participant_members, system_originated, answers_system,
               payload_state, expired_at, compartments, readers, item_enc, headers_only)
             select u.id, t.source_account_id, 'email', u.item_fp, u.tag_fp, 0, u.next_id, u.thread, u.hash, t.media_type, u.at, 'backfill',
               t.participant_members, false, false, 'expired', now(), '{own}', t.readers, u.item::jsonb, u.headers
             from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::timestamptz[], $8::boolean[], $10::text[])
               as u (id, next_id, item_fp, tag_fp, hash, thread, at, headers, item)
             cross join (select * from vault.evidence_items where id = $9) t`,
            [
              batch.map((one) => one.id),
              batch.map((one) => one.nextId),
              batch.map((one) => one.itemFp),
              batch.map((one) => one.tagFp),
              batch.map((one) => one.hash),
              batch.map((one) => one.thread),
              batch.map((one) => one.at),
              batch.map((one) => one.headers),
              template.evidence,
              batch.map((one) =>
                sealed(
                  "vault.evidence_items",
                  one.id,
                  "item_enc",
                  JSON.stringify({ sourceItemId: one.itemFp, markers: [] }),
                ),
              ),
            ],
          );
          const full = batch.filter((one) => !one.headers);
          await query(
            `insert into knowledge.messages (id, evidence_id, sent_at, direction, bulk, category, held, thread_fp, sender_fp, sender_domain_fp,
               compartments, subject_enc, thread_id_enc, sender_enc, sender_name_enc, body_enc, facts_enc)
             select u.id, u.evidence, u.at, u.direction, false, 'primary', false, u.thread, t.sender_fp, t.sender_domain_fp,
               '{own}', u.c1::jsonb, u.c2::jsonb, u.c3::jsonb, u.c4::jsonb, u.c5::jsonb, u.c6::jsonb
             from unnest($1::text[], $2::text[], $3::timestamptz[], $4::text[], $5::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[])
               as u (id, evidence, at, direction, thread, c1, c2, c3, c4, c5, c6)
             cross join (select * from knowledge.messages where id = $6) t`,
            [
              full.map((one) => one.message),
              full.map((one) => one.id),
              full.map((one) => one.at),
              full.map((one) => (one.out ? "outbound" : "inbound")),
              full.map((one) => one.thread),
              template.message,
              ...(
                [
                  ["subject_enc", "measure subject"],
                  ["thread_id_enc", "measure-thread"],
                  ["sender_enc", "measure-sender@measure-people.test"],
                  ["sender_name_enc", "Measure Sender"],
                  ["body_enc", "measure body"],
                  ["facts_enc", JSON.stringify({ chars: 12, unreadable: false, attachments: [] })],
                ] as const
              ).map(([column, value]) => full.map((one) => sealed("knowledge.messages", one.message, column, value))),
            ],
          );
          const rows = batch.flatMap((one) =>
            one.people.map((person, i) => {
              const entity = people[person]?.id ?? "";
              return {
                id: interactionId(one.id, entity),
                evidence: one.id,
                entity,
                direction: one.out ? "outbound" : "inbound",
                channel: one.headers ? "mail_headers" : "email",
                at: one.at,
                role: one.out || i > 0 ? "recipient" : "sender",
              };
            }),
          );
          await query(
            `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, entity_role, compartments, readers)
             select u.id, u.evidence, 'm-owner', u.entity, u.direction, u.channel, u.at, u.role, '{own}', '{m-owner}'
             from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::text[])
               as u (id, evidence, entity, direction, channel, at, role)`,
            [
              rows.map((one) => one.id),
              rows.map((one) => one.evidence),
              rows.map((one) => one.entity),
              rows.map((one) => one.direction),
              rows.map((one) => one.channel),
              rows.map((one) => one.at),
              rows.map((one) => one.role),
            ],
          );
        });

        // Meetings: an event, its details and two to four participants, on the template's evidence.
        const meetings = Array.from({ length: MEETINGS }, (_, n) => ({
          id: testId("evt"),
          source: sha256Hex(`event ${n}`),
          at: at().toISOString(),
          people: [...new Set(Array.from({ length: 1 + Math.floor(next() * 3) }, pick))],
        }));
        await inBatches(meetings, async (batch) => {
          await query(
            `insert into knowledge.events (id, event_kind, occurred_at, evidence_id, compartments, readers)
             select u.id, 'meeting', u.at, $3, '{own}', '{m-owner}' from unnest($1::text[], $2::timestamptz[]) as u (id, at)`,
            [batch.map((one) => one.id), batch.map((one) => one.at), template.evidence],
          );
          await query(
            `insert into knowledge.event_details (event_id, account_id, source_event_fp, starts_at, ends_at, all_day, cancelled, compartments, title_enc)
             select u.id, t.account_id, u.source, u.at, u.at + interval '1 hour', false, false, '{own}', u.title::jsonb
             from unnest($1::text[], $2::text[], $3::timestamptz[], $5::text[]) as u (id, source, at, title)
             cross join (select * from knowledge.event_details where event_id = $4) t`,
            [
              batch.map((one) => one.id),
              batch.map((one) => one.source),
              batch.map((one) => one.at),
              template.event,
              batch.map((one) => sealed("knowledge.event_details", one.id, "title_enc", "measure meeting")),
            ],
          );
          const rows = batch.flatMap((one) => one.people.map((person) => [one.id, people[person]?.id ?? ""]));
          await query(
            `insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments)
             select u.event, u.entity, 'participant', '{own}' from unnest($1::text[], $2::text[]) as u (event, entity)`,
            [rows.map(([event]) => event), rows.map(([, entity]) => entity)],
          );
        });

        // Chat lines among the closest, ten lines to an evidence row.
        const chats = Array.from({ length: CHAT }, (_, n) => {
          const person = Math.floor(CHATTERS * next() ** 2);
          return {
            id: chatLineId(n),
            evidence: mail[Math.floor(n / 10) % MAIL]?.id ?? "",
            line: n % 10,
            entity: people[person]?.id ?? "",
            direction: next() < 0.5 ? "outbound" : "inbound",
            at: at().toISOString(),
            thread: sha256Hex(`chat ${person}`),
          };
        });
        await inBatches(chats, (batch) =>
          session(db.urls.writer, (writer) =>
            writer(
              `insert into knowledge.chat_lines (id, evidence_id, line, entity_id, direction, occurred_at, others, thread_fp, compartments)
             select u.id, u.evidence, u.line, u.entity, u.direction, u.at, 1, u.thread, '{own}'
             from unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::timestamptz[], $7::text[])
               as u (id, evidence, line, entity, direction, at, thread)`,
              [
                batch.map((one) => one.id),
                batch.map((one) => one.evidence),
                batch.map((one) => one.line),
                batch.map((one) => one.entity),
                batch.map((one) => one.direction),
                batch.map((one) => one.at),
                batch.map((one) => one.thread),
              ],
            ),
          ),
        );
      });
      // Statistics, as the box's autovacuum keeps them: only the tables' owner may gather them.
      await session(db.urls.bootstrap, async (query: Query) => {
        await query("set role pi_owner");
        await query("analyze");
      });
      const seedMs = Math.round(performance.now() - seededAt);

      const pipeline = createDb(db.urls.pipeline, recordingLogger().log);
      const times: number[] = [];
      const sqlTimes: number[] = [];
      let people = 0;
      try {
        for (let run = 0; run < RUNS; run += 1) {
          let sqlMs = 0;
          const started = performance.now();
          const rows = await pipeline.transaction((query) => {
            const timed: Query = async (text, values) => {
              const at = performance.now();
              try {
                return await query(text, values);
              } finally {
                sqlMs += performance.now() - at;
              }
            };
            return computeWarmth({ query: timed, keys: db.keys }, OWN, { today: TODAY });
          });
          times.push(performance.now() - started);
          sqlTimes.push(sqlMs);
          people = rows.length;
        }
      } finally {
        await pipeline.close();
      }
      expect(people).toBeGreaterThan(0);

      // The per-label days, built as the pipeline builds them, then the ranking read as a client
      // cleared for `own`: cold (no memo) and warm.
      const built = createDb(db.urls.pipeline, recordingLogger().log);
      let buildMs = 0;
      let stored: Awaited<ReturnType<typeof computeWarmth>> = [];
      try {
        const at = performance.now();
        await buildDueDays(built, db.keys, recordingLogger().log);
        buildMs = Math.round(performance.now() - at);
        stored = await built.transaction((query) => computeWarmth({ query, keys: db.keys }, OWN, { today: TODAY }));
      } finally {
        await built.close();
      }
      const client = await insertClient(db, "warmth-measure", OWN);
      const groups = groupsFromRows([]);
      const cold: number[] = [];
      const warm: number[] = [];
      let ranked: Awaited<ReturnType<typeof rankWarmth>> = "rebuilding";
      for (let run = 0; run < RUNS; run += 1) {
        clearWarmthMemo();
        for (const times of [cold, warm]) {
          const at = performance.now();
          ranked = await readAs(db, client.token, (query) =>
            rankWarmth({ query, keys: db.keys }, { kind: "client" }, OWN, groups, { today: TODAY }),
          );
          times.push(performance.now() - at);
        }
      }
      if (ranked === "rebuilding") throw new Error("the days were not built");
      const computed = ranked;
      cold.sort((a, b) => a - b);
      warm.sort((a, b) => a - b);
      // How the computed tiers differ from the stored build's, person by person.
      const moved: Record<string, number> = {};
      let fieldsDiffer = 0;
      for (const row of stored) {
        const now = computed.get(row.entity_id);
        const step = `${row.tier}->${now?.tier ?? "none"}`;
        if (now?.tier !== row.tier) moved[step] = (moved[step] ?? 0) + 1;
        if (
          now !== undefined &&
          (now.warmth !== row.warmth ||
            now.reply_hours !== row.reply_hours ||
            now.reply_rate !== row.reply_rate ||
            now.they_start !== row.they_start)
        )
          fieldsDiffer += 1;
      }
      const tierCounts = (tiers: readonly string[]): Record<string, number> => {
        const counts: Record<string, number> = {};
        for (const tier of tiers) counts[tier] = (counts[tier] ?? 0) + 1;
        return counts;
      };
      times.sort((a, b) => a - b);
      sqlTimes.sort((a, b) => a - b);
      // get_entity end to end for the person with the most contact, through the store's reader, with
      // the ranking's memo dropped before each cold call.
      const someone = (
        await session(db.urls.admin, (query) =>
          query<{ entity_id: string }>(
            "select entity_id from knowledge.interaction_log group by entity_id order by count(*) desc, entity_id limit 1",
          ),
        )
      )[0]?.entity_id;
      if (someone === undefined) throw new Error("no person to read");
      const entityCold: number[] = [];
      const entityWarm: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        clearWarmthMemo();
        for (const times of [entityCold, entityWarm]) {
          const at = performance.now();
          const outcome = await store.reader.getEntity(client.token, { id: someone as EntityId });
          times.push(performance.now() - at);
          expect(outcome.ok ? "ok" : outcome.code).toBe("ok");
        }
      }
      entityCold.sort((a, b) => a - b);
      entityWarm.sort((a, b) => a - b);
      const report = {
        size: { people: PEOPLE, mail: MAIL, meetings: MEETINGS, chat: CHAT },
        seedMs,
        runs: RUNS,
        ranked: people,
        totalMs: { p50: Math.round(percentile(times, 0.5)), max: Math.round(times.at(-1) ?? 0) },
        sqlMs: { p50: Math.round(percentile(sqlTimes, 0.5)), max: Math.round(sqlTimes.at(-1) ?? 0) },
        days: {
          buildMs,
          coldMs: { p50: Math.round(percentile(cold, 0.5)), max: Math.round(cold.at(-1) ?? 0) },
          warmMs: { p50: Math.round(percentile(warm, 0.5)), max: Math.round(warm.at(-1) ?? 0) },
          people: computed.size,
          storedTiers: tierCounts(stored.map((row) => row.tier)),
          computedTiers: tierCounts([...computed.values()].map((row) => row.tier)),
          tierMoved: moved,
          fieldsDiffer,
        },
        getEntity: {
          coldMs: { p50: Math.round(percentile(entityCold, 0.5)), max: Math.round(entityCold.at(-1) ?? 0) },
          warmMs: { p50: Math.round(percentile(entityWarm, 0.5)), max: Math.round(entityWarm.at(-1) ?? 0) },
        },
      };
      const file = join(tmpdir(), `pi-warmth-measure-${Date.now()}.json`);
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(report)}\nwritten to ${file}\n`);
    } finally {
      await store.close();
    }
  });
});
