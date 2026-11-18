import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  type MeetingItem,
  type MeetingSegment,
  MirrorPage,
  SourceAccountId,
  type SyncMirrorArgs,
} from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { Admin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { Reader } from "../read/read.ts";
import { hashFingerprint, sha256Hex, testId } from "../test-support/clients.ts";
import { type CommitmentSpec, commitClaims, type Message } from "../test-support/commitment-fixtures.ts";
import { session } from "../test-support/connections.ts";
import { createTestDatabase, fingerprint, queryAs, sealRow, type TestDatabase } from "../test-support/database.ts";
import { eventLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import type { TestStore } from "../test-support/store.ts";
import { storeSeeder } from "../test-support/world.ts";
import { createWriter } from "../write/writer.ts";

// It is a measurement, not a gate, as deadline-measure.db.test.ts is: skipped unless PI_MEASURE=1,
// run once on the build machine under the database gate, its numbers recorded beside the mirror's
// design.
//
//   PI_MEASURE=1 pnpm vitest run --config vitest.db.config.ts packages/store/src/lens/lens-measure.db.test.ts
//
// The world: PI_MEASURE_PEOPLE people (one message each, so one entity each), PI_MEASURE_FACTS
// commitment claims on their messages, PI_MEASURE_BELIEFS of them with the `own` audience's belief,
// PI_MEASURE_EVENTS calendar events within the events section's 180 days, and PI_MEASURE_CAPTURES
// stored meetings, all under `own`, through the writer and the pipeline but the capture items,
// written as the drain leaves them. The mirror client of each budget is a device's, cleared for
// `own` with every view. The mirror client's minute quota is raised to its bound (600) and calls
// are paced to it, so the quota is never what a call meets.

const MEASURE = process.env.PI_MEASURE === "1";
// About 3 000 entries by default. Full size, for a run on the box: PEOPLE 15000, FACTS
// 20000, BELIEFS 8000, EVENTS 3000, CAPTURES 4000, PUSHES 400, and a longer timeout (TIMEOUT_MS).
const PEOPLE = Number(process.env.PI_MEASURE_PEOPLE ?? 800);
const FACTS = Number(process.env.PI_MEASURE_FACTS ?? 1_200);
const BELIEFS = Number(process.env.PI_MEASURE_BELIEFS ?? 500);
const EVENTS = Number(process.env.PI_MEASURE_EVENTS ?? 300);
const CAPTURES = Number(process.env.PI_MEASURE_CAPTURES ?? 200);
const PUSHES = Number(process.env.PI_MEASURE_PUSHES ?? 40);
// Passes from a null cursor at each budget, for more calls to take percentiles over.
const PASSES = Number(process.env.PI_MEASURE_PASSES ?? 3);
const TIMEOUT_MS = Number(process.env.PI_MEASURE_TIMEOUT_MS ?? 15 * 60_000);
const BUDGETS = [100, 50, 25] as const;

// The agent API's deadlines (packages/mcp/src/deadlines.ts), which the store cannot import: WIDE
// for sync_mirror, WRITE for push_capture;
const WIDE_MS = 1_500;
const WRITE_MS = 600;
const BUILD_SHARE = 0.6;

// MIRROR_BUILD_PER_CALL as each measurement sets it: the reader reads the constant from contracts
// at each call, so a getter over this holder sets the budget without a change to the code.
const budget = vi.hoisted(() => ({ value: 100 }));
vi.mock("@intelligence/contracts/personal", async (original) => {
  const actual = await original<typeof import("@intelligence/contracts/personal")>();
  return {
    ...actual,
    get MIRROR_BUILD_PER_CALL() {
      return budget.value;
    },
  };
});
// Every call of seal.ts's two open functions, as mirror-sync.db.test.ts counts a quiet pass's.
const opened = vi.hoisted(() => ({ count: 0 }));
vi.mock("../core/seal.ts", async (original) => {
  const actual = await original<typeof import("../core/seal.ts")>();
  return {
    ...actual,
    openRow: (...args: Parameters<typeof actual.openRow>) => {
      opened.count += 1;
      return actual.openRow(...args);
    },
    openUnder: (...args: Parameters<typeof actual.openUnder>) => {
      opened.count += 1;
      return actual.openUnder(...args);
    },
  };
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const OWNER = "owner.measure@example.com";
const VIEWS = ["self", "people", "work"] as const;
// Calls of one client at most this often: the bound of a client's minute quota is 600.
const PACE_MS = 110;

const percentile = (sorted: number[], p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
const deadlineOf = (p999: number): number => Math.max(100, Math.ceil((2 * p999) / 100) * 100);
const summary = (times: number[]): { calls: number; p50: number; p99: number; p999: number; max: number } => {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    calls: sorted.length,
    p50: Math.round(percentile(sorted, 0.5)),
    p99: Math.round(percentile(sorted, 0.99)),
    p999: Math.round(percentile(sorted, 0.999)),
    max: Math.round(sorted.at(-1) ?? 0),
  };
};
// Least squares of y on x: the intercept and the slope.
function fit(points: readonly { x: number; y: number }[]): { intercept: number; slope: number } {
  const n = points.length;
  const mx = points.reduce((sum, p) => sum + p.x, 0) / n;
  const my = points.reduce((sum, p) => sum + p.y, 0) / n;
  const sxx = points.reduce((sum, p) => sum + (p.x - mx) ** 2, 0);
  const slope = sxx === 0 ? 0 : points.reduce((sum, p) => sum + (p.x - mx) * (p.y - my), 0) / sxx;
  return { intercept: my - slope * mx, slope };
}
const round = (value: number, places = 3): number => Math.round(value * 10 ** places) / 10 ** places;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const asStore = (db: TestDatabase): TestStore => ({ db }) as unknown as TestStore;

// A stored meeting as the drain leaves it, written as pi_admin, as mirror-gate's captureIn writes
// one.
async function storeMeetings(db: TestDatabase, account: string, count: number): Promise<void> {
  await session(db.urls.admin, async (query) => {
    for (let n = 0; n < count; n += 1) {
      const start = new Date(T - (n % 300) * DAY - (n + 1) * MINUTE);
      const blob = await seeder(db, query).blob(["own"]);
      const key = `meeting:${testId("k").slice(2)}`;
      const source = { vault: "personal" as const, sourceAccount: SourceAccountId.parse(account), sourceItemId: key };
      const evidence = evidenceIdFor({ ...source, revision: 0 });
      const id = testId("cap");
      const sealed = (table: string, row: string, column: string, value: string): string =>
        JSON.stringify(sealRow(db.keys, "own", { table, id: row, column }, value));
      await query(
        `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, next_revision_id, content_hash, media_type,
           observed_at, change_kind, participant_members, system_originated, answers_system, payload_state, compartments, readers, blob_ref, item_enc)
         values ($1, $2, 'transcript', $3, $4, 0, $5, $6, 'application/json', $7, 'live', '{m-owner}', false, false, 'present', '{own}', '{m-owner}', $8, $9::jsonb)`,
        [
          evidence,
          account,
          fingerprint(db.keys, "source_id", key),
          fingerprint(db.keys, "revision_tag", `h:${key}`),
          evidenceIdFor({ ...source, revision: 1 }),
          hashFingerprint(db.keys, "content_hash", sha256Hex(`measure capture ${key}`)),
          start.toISOString(),
          blob,
          sealed("vault.evidence_items", evidence, "item_enc", JSON.stringify({ sourceItemId: key, markers: [] })),
        ],
      );
      await query(
        `insert into knowledge.captures (id, evidence_id, source_account_id, capture_key, revision, kind, started_at, ended_at, event_id, first_pushed_at, local_day, facts_enc, compartments)
         values ($1, $2, $3, $4, 0, 'meeting', $5, $6, null, $6, $7, $8::jsonb, '{own}')`,
        [
          id,
          evidence,
          account,
          key,
          start.toISOString(),
          new Date(start.getTime() + 30 * MINUTE).toISOString(),
          start.toISOString().slice(0, 10),
          sealed("knowledge.captures", id, "facts_enc", JSON.stringify({ title: `measure meeting ${n}` })),
        ],
      );
    }
  });
}

// A batch just under 1 MiB of JSON: meetings of 1 500 segments, the last cut to fit.
let keys = 0;
const meetingKey = (): string => `meeting:01JMXPSH${String((keys += 1)).padStart(18, "0")}`;
function meetingOf(segments: number): MeetingItem {
  const at = (offset: number): string => `${new Date(T - DAY + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
  const segment = (n: number): MeetingSegment => ({
    speaker: n % 2 === 0 ? "S1" : "S2",
    fromMs: n * 2_000,
    toMs: n * 2_000 + 1_900,
    channel: n % 2 === 0 ? "input" : "output",
    text: `measure words ${"x".repeat(56)}`,
  });
  return {
    kind: "meeting",
    key: meetingKey(),
    revision: 0,
    startedAt: at(0),
    endedAt: at(HOUR),
    app: { bundle: "test.example.meet", name: "Meet" },
    title: "Measure call",
    consent: true,
    mode: "call",
    speakers: [
      { label: "S1", owner: true },
      { label: "S2", owner: false },
    ],
    segments: Array.from({ length: segments }, (_, n) => segment(n)),
  } as MeetingItem;
}
const TARGET_BYTES = 1_040_000;
function largeBatch(): { batch: string; items: MeetingItem[] } {
  const items: MeetingItem[] = [];
  const size = (): number => Buffer.byteLength(JSON.stringify({ batch: "measure-batch-000000", items }), "utf8");
  const perSegment =
    (Buffer.byteLength(JSON.stringify(meetingOf(101)), "utf8") -
      Buffer.byteLength(JSON.stringify(meetingOf(1)), "utf8")) /
    100;
  for (;;) {
    items.push(meetingOf(1_500));
    if (size() <= TARGET_BYTES) continue;
    items.pop();
    const left = Math.floor((TARGET_BYTES - size() - 1_000) / perSegment);
    if (left > 0) items.push(meetingOf(Math.min(1_500, left)));
    break;
  }
  return { batch: `measure-batch-${String(keys).padStart(6, "0")}`, items };
}

describe.skipIf(!MEASURE)("the mirror's build budget and the 1 MiB push", () => {
  it("records each budget's 99.9th percentile, the push's, and a quiet pass against a rebuild", {
    timeout: TIMEOUT_MS,
  }, async () => {
    const db = await createTestDatabase({ compartments: ["own"] });
    const log = eventLogger();
    const clock = { at: T };
    const adminPool = new pg.Pool({ connectionString: db.urls.admin, max: 2 });
    const readerPool = new pg.Pool({ connectionString: db.urls.reader, max: 4 });
    const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
    const admin = new Admin({
      pool: adminPool,
      keys: db.keys,
      log,
      now: () => new Date(clock.at),
      journal: journalPath(db.keyFile),
    });
    const reader = new Reader({ pool: readerPool, keys: db.keys, log, now: () => new Date(clock.at) });
    try {
      // The world, grown.
      const seed = storeSeeder(writer, new Date(T));
      const mailbox = await writer.ensureSourceAccount("personal", "google_mail", "own", OWNER);
      const calendar = await writer.ensureSourceAccount("personal", "google_calendar", "own", OWNER);
      const person = (n: number) => ({ address: `person-${n}@measure.test`, name: `Measure Person${n}` });
      for (let n = 0; n < PEOPLE; n += 1)
        await seed.mail(mailbox, {
          id: `measure-${n}`,
          from: person(n),
          to: [{ address: OWNER }],
          at: new Date(T - (n + 1) * MINUTE),
          subject: `measure subject ${n}`,
        });
      for (let n = 0; n < EVENTS; n += 1) {
        const start = new Date(T + ((n % 360) - 180) * DAY + (n % 600) * MINUTE);
        await seed.event(calendar, {
          id: `measure-event-${n}`,
          title: `measure event ${n}`,
          start,
          end: new Date(start.getTime() + HOUR),
          organizer: { address: OWNER },
          attendees: [{ address: person(n % PEOPLE).address }],
        });
      }
      const owner = seed.ownerEntity();
      // The messages newest first: the n-th is person n's (its time is T less n + 1 minutes).
      const messages = (
        await queryAs<{ id: string; evidence_id: string; sent_at: Date; compartment: string }>(
          db.urls.admin,
          "select id, evidence_id, sent_at, compartments[1] as compartment from knowledge.messages order by sent_at desc, id",
        )
      ).map(
        (row): Message => ({
          id: row.id,
          evidenceId: row.evidence_id,
          sentAt: row.sent_at.toISOString(),
          compartment: row.compartment,
        }),
      );
      expect(messages).toHaveLength(PEOPLE);
      const specs: CommitmentSpec[] = Array.from({ length: FACTS }, (_, n) => ({
        key: `measure-commitment-${n}`,
        subject: seed.entityOf(person(n % PEOPLE).address),
        counterparty: owner,
        claims: [{ message: messages[n % PEOPLE] as Message, what: `measure what ${n}` }],
      }));
      await commitClaims(asStore(db), owner, specs);

      // One device for each budget, its mirror client a pass of its own; the meetings under the
      // first's account. The quiet and rebuild passes are the first's.
      const mirrors: { name: string; token: string }[] = [];
      for (const name of BUDGETS.map((value) => `measure-${value}`)) {
        await admin.lens.addDevice(name, { compartments: ["own"], views: [...VIEWS] });
        // The mirror's first token is the first rotation's.
        const token = await admin.lens.rotateDevice(name, "mirror");
        await admin.clients.setQuota(name, { maxCallsMinute: 600 });
        mirrors.push({ name, token });
      }
      const [account] = await queryAs<{ id: string }>(
        db.urls.admin,
        "select id from vault.source_accounts where label = 'device:measure-100' and connector = 'lens_meetings'",
      );
      await storeMeetings(db, account?.id ?? "", CAPTURES);
      const [size] = await queryAs<{ bytes: string }>(
        db.urls.admin,
        "select pg_database_size(current_database())::text as bytes",
      );

      // One call, timed, paced to the client's quota; the page or a failure.
      let lastCall = 0;
      const call = async (token: string, cursor: string | null): Promise<{ ms: number; page: MirrorPage }> => {
        const wait = lastCall + PACE_MS - performance.now();
        if (wait > 0) await pause(wait);
        lastCall = performance.now();
        const started = performance.now();
        const answer = await reader.syncMirror(token, { templates: ["lens_mirror@1"], cursor } as SyncMirrorArgs);
        const ms = performance.now() - started;
        if (!answer.ok) throw new Error(`sync_mirror answered ${answer.code}`);
        return { ms, page: MirrorPage.parse(answer.value) };
      };
      // A whole pass, each page confirmed by the next call's cursor.
      const pass = async (
        token: string,
        from: string | null,
      ): Promise<{
        times: number[];
        points: { x: number; y: number }[];
        entries: number;
        most: number;
        cursor: string;
        opened: number;
        ms: number;
      }> => {
        const times: number[] = [];
        const points: { x: number; y: number }[] = [];
        let entries = 0;
        let most = 0;
        let cursor = from;
        const before = opened.count;
        for (let n = 0; n < 100_000; n += 1) {
          const { ms, page } = await call(token, cursor);
          times.push(ms);
          points.push({ x: page.entries.length, y: ms });
          entries += page.entries.length;
          most = Math.max(most, page.entries.length);
          cursor = page.cursor;
          if (page.passComplete)
            return {
              times,
              points,
              entries,
              most,
              cursor: page.cursor,
              opened: opened.count - before,
              ms: times.reduce((a, b) => a + b, 0),
            };
        }
        throw new Error("no pass completed");
      };
      // When the client's last pass completed, by the database's clock, which stamps it.
      const completedAt = async (name: string): Promise<number> => {
        const [row] = await queryAs<{ at: Date | null }>(
          db.urls.admin,
          "select max(m.completed_at) as at from ledger.mirror_cursors m join policy.clients c on c.id = m.client_id where c.name = $1",
          [name],
        );
        if (row?.at === null || row?.at === undefined) throw new Error("no completed pass");
        return row.at.getTime();
      };

      // The budgets: PASSES full syncs from null at each, every call timed. A null cursor
      // rebuilds, so every call of a pass builds what it sends.
      const budgets: {
        budget: number;
        calls: number;
        entries: number;
        meanEntries: number;
        p50: number;
        p99: number;
        p999: number;
        max: number;
        underShare: boolean;
      }[] = [];
      const points: { x: number; y: number }[] = [];
      let firstCursor = "";
      for (const [index, value] of BUDGETS.entries()) {
        budget.value = value;
        const mirror = mirrors[index] ?? { name: "", token: "" };
        const times: number[] = [];
        let entries = 0;
        for (let n = 0; n < PASSES; n += 1) {
          const done = await pass(mirror.token, null);
          // The budget took: no page holds more entries than its call may build.
          expect(done.most, `budget ${value}`).toBeLessThanOrEqual(value);
          if (index === 0) firstCursor = done.cursor;
          times.push(...done.times);
          points.push(...done.points);
          entries += done.entries;
        }
        const stats = summary(times);
        budgets.push({
          budget: value,
          entries,
          meanEntries: round(entries / times.length, 1),
          ...stats,
          underShare: stats.p999 < WIDE_MS * BUILD_SHARE,
        });
      }
      const chosen = budgets
        .filter((row) => row.underShare)
        .reduce<number | null>((best, row) => (best === null || row.budget > best ? row.budget : best), null);
      // The derivation: a call's time against the entries it built, on average and at the tail.
      const share = WIDE_MS * BUILD_SHARE;
      const mean = fit(points);
      const tail = fit(budgets.map((row) => ({ x: row.budget, y: row.p999 })));
      // Capped at the largest budget measured: the line is not evidence past the points it fits.
      const most = Math.max(...BUDGETS);
      const unbounded = tail.slope <= 0 ? null : Math.max(0, Math.floor((share - tail.intercept) / tail.slope));
      const derived = unbounded === null ? null : Math.min(most, unbounded);

      // P2-11: on the first client, a quiet pass (tokens kept) and then a rebuild pass (tokens
      // ignored), each started by moving the reader's clock past PI_MIRROR_PASS_SECONDS, and past
      // PI_MIRROR_REBUILD_HOURS for the rebuild. The budget is the current one.
      budget.value = 100;
      const first = mirrors[0] ?? { name: "", token: "" };
      clock.at = (await completedAt(first.name)) + 3_601_000;
      const quiet = await pass(first.token, firstCursor);
      clock.at = (await completedAt(first.name)) + 25 * HOUR;
      const rebuild = await pass(first.token, quiet.cursor);
      const passes = {
        quiet: {
          ms: Math.round(quiet.ms),
          calls: quiet.times.length,
          entriesSent: quiet.entries,
          opened: quiet.opened,
        },
        rebuild: {
          ms: Math.round(rebuild.ms),
          calls: rebuild.times.length,
          entriesSent: rebuild.entries,
          opened: rebuild.opened,
        },
      };

      // The push: a batch just under 1 MiB, from a dozen devices in turn so no device's minute or
      // day bounds are met, the inbox emptied as pi_owner every 40 pushes so the store does not
      // grow by a gigabyte; and pg_database_size alone, on the reader's pool.
      const devices: string[] = [];
      for (let n = 0; n < 12; n += 1)
        devices.push(
          (await admin.lens.addDevice(`measure-push-${n}`, { compartments: ["own"], views: ["self"] })).capture,
        );
      await admin.lens.addScope({
        match: "bundle",
        value: "test.example.meet",
        compartment: "own",
        kinds: ["meeting"],
      });
      const emptyInbox = (): Promise<void> =>
        session(db.urls.bootstrap, async (query) => {
          await query("set role pi_owner");
          await query("delete from ledger.capture_inbox");
          await query("delete from policy.capture_push_refusals");
        });
      const pushTimes: number[] = [];
      const outcomes = new Set<string>();
      let bytes = 0;
      for (let n = 0; n < PUSHES; n += 1) {
        if (n > 0 && n % 40 === 0) await emptyInbox();
        // The request's body as pi http reads it: the JSON is parsed in the timed span, as the
        // route parses it before the dispatcher hands the arguments to the reader. The route
        // itself (createRoutes) is personal-mcp's, which the store does not import; the reader
        // checks the arguments against PushCaptureArgs itself, inside the span.
        const body = JSON.stringify(largeBatch());
        bytes = Buffer.byteLength(body, "utf8");
        const started = performance.now();
        const answer = await reader.pushCapture(
          devices[n % devices.length] ?? "",
          JSON.parse(body) as Parameters<Reader["pushCapture"]>[1],
        );
        pushTimes.push(performance.now() - started);
        if (!answer.ok) outcomes.add(answer.code);
        else
          for (const item of answer.value.items)
            outcomes.add(item.outcome === "refused" ? `refused:${item.code}` : item.outcome);
      }
      await emptyInbox();
      expect([...outcomes]).toEqual(["accepted"]);
      const sizeTimes: number[] = [];
      for (let n = 0; n < PUSHES; n += 1) {
        const started = performance.now();
        await readerPool.query("select pg_database_size(current_database())");
        sizeTimes.push(performance.now() - started);
      }
      const push = summary(pushTimes);
      const sized = summary(sizeTimes);
      const pushDeadline = deadlineOf(push.p999);

      const report = {
        world: {
          people: PEOPLE,
          facts: FACTS,
          beliefs: BELIEFS,
          events: EVENTS,
          captures: CAPTURES,
          databaseBytes: Number(size?.bytes ?? 0),
        },
        syncMirror: {
          deadlineMs: WIDE_MS,
          buildShareMs: share,
          passesPerBudget: PASSES,
          budgets,
          chosenBudget: chosen,
          fitMean: { overheadMs: round(mean.intercept), perEntryMs: round(mean.slope) },
          fitP999: { interceptMs: round(tail.intercept), perEntryMs: round(tail.slope) },
          derivedBudget: derived,
          derivedUncapped: unbounded,
        },
        passes,
        pushCapture: {
          batchBytes: bytes,
          ...push,
          deadlineMs: pushDeadline,
          writeDeadlineMs: WRITE_MS,
          raise: pushDeadline > WRITE_MS,
        },
        pgDatabaseSize: {
          ...sized,
          shareOfPushP50: push.p50 === 0 ? 0 : Math.round((sized.p50 / push.p50) * 1000) / 1000,
        },
      };
      const file = join(tmpdir(), `pi-lens-measure-${Date.now()}.json`);
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(
        `${[
          `world\t${report.world.people} people, ${report.world.facts} facts, ${report.world.beliefs} beliefs, ${report.world.events} events, ${report.world.captures} meetings, ${report.world.databaseBytes} bytes`,
          ...budgets.map(
            (row) =>
              `sync_mirror budget ${row.budget}\t${row.calls} calls\t${row.entries} entries\tp50 ${row.p50} ms\tp99.9 ${row.p999} ms\tmax ${row.max} ms\t${row.underShare ? "under" : "over"} ${WIDE_MS * BUILD_SHARE} ms`,
          ),
          `chosen budget\t${chosen ?? "none: every budget measured is over the share"}`,
          `fit mean\tms = ${round(mean.intercept)} overhead + ${round(mean.slope)} x entries, over ${points.length} calls`,
          `fit p99.9\tms = ${round(tail.intercept)} + ${round(tail.slope)} x budget, through the budgets' p99.9`,
          `derived budget\t${derived === null ? "none: the p99.9 does not grow with the budget, so this world cannot bound it" : `min(${most}, floor((${share} - ${round(tail.intercept)}) / ${round(tail.slope)}) = ${unbounded}) = ${derived}`}`,
          `full size, for the box\tPI_MEASURE=1 PI_MEASURE_PEOPLE=15000 PI_MEASURE_FACTS=20000 PI_MEASURE_BELIEFS=8000 PI_MEASURE_EVENTS=3000 PI_MEASURE_CAPTURES=4000 PI_MEASURE_PUSHES=400 PI_MEASURE_TIMEOUT_MS=28800000 (this run: ${PEOPLE}, ${FACTS}, ${BELIEFS}, ${EVENTS}, ${CAPTURES}, ${PUSHES})`,
          `quiet pass\t${passes.quiet.ms} ms\t${passes.quiet.calls} calls\t${passes.quiet.entriesSent} entries sent\t${passes.quiet.opened} opened`,
          `rebuild pass\t${passes.rebuild.ms} ms\t${passes.rebuild.calls} calls\t${passes.rebuild.entriesSent} entries sent\t${passes.rebuild.opened} opened`,
          `push_capture 1 MiB\t${bytes} bytes\tp50 ${push.p50} ms\tp99.9 ${push.p999} ms\tdeadline ${pushDeadline} ms against WRITE ${WRITE_MS} ms`,
          `pg_database_size\tp50 ${sized.p50} ms\tp99.9 ${sized.p999} ms\t${report.pgDatabaseSize.shareOfPushP50} of a push's p50`,
          `written to ${file}`,
        ].join("\n")}\n`,
      );
    } finally {
      await writer.close();
      await readerPool.end();
      await adminPool.end();
      await db.drop();
    }
  });
});
