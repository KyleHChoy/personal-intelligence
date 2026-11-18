import { randomBytes } from "node:crypto";
import type { Claim, EvidenceId } from "@intelligence/contracts";
import {
  ACTIVITY_PIPELINE,
  type BlockItem,
  type BlockPage,
  type CaptureItem,
  CaptureWork,
  type ClaimRecord,
  type EntityId,
  MIRROR_QUOTA,
  QUOTA_DEFAULTS,
  SEARCH_HOSTS,
} from "@intelligence/contracts/personal";
import { afterAll, describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { openUnder, sealRow } from "../core/seal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { createReader } from "../read/read.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { copiesOf, createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { batchOf } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { createWriter } from "../write/writer.ts";
import { capturesErasure } from "./capture-erasure.ts";

// Reserved domains, made-up names and test bundles; the search host is a product name from
// SEARCH_HOSTS. No model is called.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;
const T = Math.floor(Date.now() / DAY_MS) * DAY_MS - 2 * DAY_MS;
const DAY = new Date(T).toISOString().slice(0, 10);
const at = (minutes: number): string => new Date(T + 13 * HOUR + minutes * MINUTE).toISOString();
const CHROME = { bundle: "com.google.Chrome", name: "Chrome" };
const DOCS = "docs.example.org";
const CORP = "corp.example.net";
const CHAT = "chat.example.ai";
const SEARCH = SEARCH_HOSTS[0] as string;
const ROBIN = "Robin Vale";
const HIDDEN = "Sam Hiddenfield";

const page = (url: string, title: string | undefined, over: Partial<BlockPage> = {}): BlockPage => ({
  url,
  ...(title === undefined ? {} : { title }),
  firstAt: at(1),
  lastAt: at(5),
  count: 2,
  ...over,
});
// The own day: one browser block on the docs host with every kind of page, and one on the
// employer's host carrying an own page.
const PAGES: BlockPage[] = [
  page(`https://${DOCS}/alpha`, "Alpha budget plan"),
  page(`https://${DOCS}/robin`, `${ROBIN} budget review`),
  page(`https://${DOCS}/hidden`, `${HIDDEN} notes`),
  page(`https://${SEARCH}/search`, "alpha budget", { query: "alpha budget" }),
  page(`https://${CORP}/roadmap`, "Corp roadmap"),
  page("https://unlisted.example.com/a", "Unlisted"),
  page("https://mail.google.com/mail/u/0", "Inbox"),
  page(`https://${CHAT}/c/1`, "Chat about budgets"),
  page(`https://${DOCS}/ids`, "Look at ent_01JABCDEFGHJKMNPQRSTVWXYZ0"),
  page(`https://${SEARCH}/search`, "code", { query: "code 482913" }),
];
const DAY_ITEM: BlockItem = {
  kind: "block",
  key: "block:01JPAGESDBA000000000000001",
  revision: 0,
  day: DAY,
  blocks: [
    { start: at(0), end: at(20), minutes: 20, app: CHROME, title: "Alpha budget plan", host: DOCS, pages: PAGES },
    {
      start: at(30),
      end: at(40),
      minutes: 10,
      app: CHROME,
      title: "Corp roadmap",
      host: CORP,
      pages: [
        page(`https://${CORP}/plan`, "Corp plan", { firstAt: at(31), lastAt: at(32) }),
        page(`https://${DOCS}/own`, "Own page", { firstAt: at(31), lastAt: at(33) }),
      ],
    },
  ],
};

const request = () => ({ requestId: `req-pages-${randomBytes(6).toString("hex")}` });
const admin = <Row = Record<string, unknown>>(db: TestDatabase, sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);

async function addDevice(db: TestDatabase): Promise<string> {
  const capture = { id: testId("cli"), token: `pit_test-pages-capture-${randomBytes(8).toString("hex")}` };
  const mirror = testId("cli");
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  const insertClient = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  await session(db.urls.admin, async (query) => {
    await query("begin");
    await query(insertClient, [
      capture.id,
      "mac-capture",
      sha256Hex(capture.token),
      ["own"],
      ["self"],
      ["push_capture"],
      "device",
      ...quota(QUOTA_DEFAULTS.device),
    ]);
    await query(insertClient, [
      mirror,
      "mac",
      sha256Hex(`pit_test-pages-mirror-${randomBytes(8).toString("hex")}`),
      ["employer:example", "own"],
      ["self", "people", "work"],
      ["sync_mirror"],
      "agent",
      ...quota(MIRROR_QUOTA),
    ]);
    await query("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
      "mac",
      capture.id,
      mirror,
    ]);
    for (const [connector, kind] of [
      ["lens_meetings", "transcript"],
      ["lens_activity", "screen_activity"],
      ["lens_blocks", "time_block"],
    ] as const) {
      await query(
        "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', $2, $3, '{own}')",
        [testId("acc"), connector, kind],
      );
    }
    await query("commit");
  });
  return capture.token;
}

async function insertScope(db: TestDatabase, host: string, compartment: string, agentApp = false): Promise<void> {
  const id = testId("csr");
  await admin(
    db,
    "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds, agent_app) values ($1, 'host', $2, $3, null, null, $4, $5, $6)",
    [
      id,
      fingerprint(db.keys, "capture_scope", host),
      sealRow(db.keys, "own", { table: "policy.capture_scope", id, column: "value_enc" }, host),
      compartment,
      agentApp ? ["moment", "block"] : ["block"],
      agentApp,
    ],
  );
}

// People with one alias each under the given compartments, as the identity step keeps a name, and
// an account each (erasePerson finds a person by its accounts). One seeder, so no two share an
// address.
async function people(db: TestDatabase, given: { name: string; compartments: string[] }[]): Promise<EntityId[]> {
  return session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    const made: EntityId[] = [];
    for (const { name, compartments } of given) {
      const entity = await seed.entity("person");
      await seed.account(compartments, entity);
      const evidence = await seed.evidence(compartments);
      const id = testId("als");
      await query(
        "insert into knowledge.aliases (id, entity_id, value_fp, evidence_id, value_enc, compartments) values ($1, $2, $3, $4, $5, $6)",
        [
          id,
          entity,
          fingerprint(db.keys, "name", name),
          evidence,
          sealRow(db.keys, compartments[0] as string, { table: "knowledge.aliases", id, column: "value_enc" }, name),
          compartments,
        ],
      );
      made.push(entity as EntityId);
    }
    return made;
  });
}

type Built = {
  token: string;
  robin: EntityId;
  split: EvidenceId;
  capture: string;
  employer: EvidenceId;
  owner: string;
  counts: Record<string, number>;
};
let built: Built | undefined;
const b = (): Built => {
  if (built === undefined) throw new Error("the world is not built");
  return built;
};

const world = copiesOf(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  const owner = createAdmin({ url: db.urls.admin, keys: db.keys, log, journal: journalPath(db.keyFile) });
  try {
    const token = await addDevice(db);
    await owner.accounts.addOwnerAddress("quinn@example.org", "own");
    await insertScope(db, DOCS, "own");
    await insertScope(db, SEARCH, "own");
    await insertScope(db, CORP, "employer:example");
    await insertScope(db, CHAT, "own", true);
    const [robin] = (await people(db, [
      { name: ROBIN, compartments: ["own"] },
      { name: HIDDEN, compartments: ["employer:example"] },
    ])) as [EntityId];
    const item = { ...DAY_ITEM, coveredThrough: `${DAY}T23:59:42.500Z` } as CaptureItem;
    const answer = await reader.pushCapture(token, { batch: "pages-0001", items: [item] });
    expect(answer).toEqual({ ok: true, value: { items: [{ key: DAY_ITEM.key, outcome: "accepted" }] } });
    const counts = await writer.takeCapture();
    expect(counts).toMatchObject({ failed: 0, waiting: 0 });
    const split = one(
      await admin<{ evidence_id: EvidenceId; id: string }>(
        db,
        "select evidence_id, id from knowledge.captures where capture_key = $1 and compartments = '{own}'",
        [DAY_ITEM.key],
      ),
    );
    const employer = one(
      await admin<{ evidence_id: EvidenceId }>(
        db,
        "select evidence_id from knowledge.captures where capture_key = $1 and compartments = '{employer:example}'",
        [DAY_ITEM.key],
      ),
    );
    const ownerEntity = one(
      await admin<{ id: string }>(db, "select id from knowledge.entities where kind = 'owner'"),
    ).id;
    built = {
      token,
      robin,
      split: split.evidence_id,
      capture: split.id,
      employer: employer.evidence_id,
      owner: ownerEntity,
      counts: counts.dropped,
    };
  } finally {
    await owner.close();
    await reader.close();
    await writer.close();
  }
  return db;
});

afterAll(async () => {
  await world.drop();
}, DB_TEST_TIMEOUT);

async function withWorld(fn: (db: TestDatabase) => Promise<void>): Promise<void> {
  const db = await world.copy();
  try {
    await fn(db);
  } finally {
    await db.drop();
  }
}

const workOf = async (
  db: TestDatabase,
  key: string,
  compartments: string[],
): Promise<Extract<CaptureWork, { kind: "block" }>> => {
  const row = one(
    await admin<{ id: string; work_enc: unknown }>(
      db,
      "select id, work_enc from knowledge.captures where capture_key = $1 and compartments = $2",
      [key, compartments],
    ),
  );
  const work = CaptureWork.parse(
    JSON.parse(
      openUnder(
        db.keys,
        compartments,
        { table: "knowledge.captures", id: row.id, column: "work_enc" },
        row.work_enc as never,
      ),
    ),
  );
  if (work.kind !== "block") throw new Error("a block day");
  return work;
};
const urlsOf = (work: Extract<CaptureWork, { kind: "block" }>): string[] =>
  work.blocks.flatMap((block) => (block.pages ?? []).map((one) => `${one.url} ${one.query ?? ""}`.trim()));
const blobPagesOf = async (db: TestDatabase, evidence: EvidenceId): Promise<string[]> => {
  const row = one(
    await admin<{ blob_ref: string; compartments: string[] }>(
      db,
      "select blob_ref, compartments from vault.evidence_items where id = $1",
      [evidence],
    ),
  );
  const blob = one(
    await admin<{ envelope: unknown }>(db, "select envelope from vault.evidence_blobs where blob_ref = $1", [
      row.blob_ref,
    ]),
  );
  const item = JSON.parse(
    Buffer.from(
      openUnder(
        db.keys,
        row.compartments,
        { table: "vault.evidence_blobs", id: row.blob_ref, column: "envelope" },
        blob.envelope as never,
      ),
      "base64",
    ).toString("utf8"),
  ) as BlockItem;
  return item.blocks.flatMap((block) => (block.pages ?? []).map((one) => one.url));
};

describe("history pages at the drain", { timeout: DB_TEST_TIMEOUT }, () => {
  it("each page by its own host's rule and checks; the kept pages alone in the split's work_enc and blob, each drop counted by its code", () =>
    withWorld(async (db) => {
      const { counts, split } = b();
      const own = await workOf(db, DAY_ITEM.key, ["own"]);
      expect(urlsOf(own)).toEqual([
        `https://${DOCS}/alpha`,
        `https://${DOCS}/robin`,
        `https://${DOCS}/hidden`,
        `https://${SEARCH}/search alpha budget`,
      ]);
      expect(await blobPagesOf(db, split)).toEqual([
        `https://${DOCS}/alpha`,
        `https://${DOCS}/robin`,
        `https://${DOCS}/hidden`,
        `https://${SEARCH}/search`,
      ]);
      // The employer's split keeps its own page and drops the own one it carried.
      expect(urlsOf(await workOf(db, DAY_ITEM.key, ["employer:example"]))).toEqual([`https://${CORP}/plan`]);
      expect(counts).toMatchObject({
        page_compartment: 2,
        page_out_of_scope: 2,
        page_agent_app: 1,
        page_system_ids: 1,
        credential_shaped: 1,
      });
      expect(counts.page_erased).toBeUndefined();
    }));

  it("coveredThrough is sealed to the minute, and never before the split's own last block end", () =>
    withWorld(async (db) => {
      expect((await workOf(db, DAY_ITEM.key, ["own"])).coveredThrough).toBe(`${DAY}T23:59:00Z`);
      expect((await workOf(db, DAY_ITEM.key, ["employer:example"])).coveredThrough).toBe(`${DAY}T23:59:00Z`);
    }));

  it("openBlockDay names the runs that name a person the split's label can see, and no other", () =>
    withWorld(async (db) => {
      const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
      try {
        const opened = await pipeline.openBlockDay(b().split);
        expect(opened?.named).toContain("robin vale");
        expect(opened?.named.some((run) => run.includes("hiddenfield"))).toBe(false);
        expect(opened?.blocks?.[0]?.pages.map((one) => [one.host, one.title, one.query])).toEqual([
          [DOCS, "Alpha budget plan", null],
          [DOCS, `${ROBIN} budget review`, null],
          [DOCS, `${HIDDEN} notes`, null],
          [SEARCH, "alpha budget", "alpha budget"],
        ]);
      } finally {
        await pipeline.close();
      }
    }));
});

// An activity.researched claim as the block lane hands it over, on the own split.
function researched(evidence: EvidenceId, owner: string): ClaimRecord {
  const fields = { topic: "robin vale budget review", host: DOCS };
  const claim = {
    id: `${evidence.slice(0, 56)}00ab0002`,
    content: { type: "activity.researched", subject: owner, fields },
    statementKind: "stated_fact",
    basis: "system_observed",
    validFrom: at(0),
    validTo: at(20),
    evidence: [{ evidenceId: evidence, span: `activity:researched:${at(0)}` }],
    primaryEvidenceId: evidence,
    label: { compartments: ["own"], readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: ACTIVITY_PIPELINE,
    extractorGeneration: 1,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  return {
    claim,
    subjectKind: "owner",
    disclosure: [],
    factKey: `researched ${owner} robin`,
    lane: "skip",
    fieldKinds: { topic: "text", host: "text" },
    entities: [],
    origin: "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}

async function commitResearched(db: TestDatabase): Promise<void> {
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  try {
    expect(
      await pipeline.commit(
        batchOf(b().split, [researched(b().split, b().owner)], {
          lane: "skip",
          status: "skipped",
          code: "not_extracted",
        } as never),
      ),
    ).toBe("committed");
  } finally {
    await pipeline.close();
  }
}
const claimsOf = async (db: TestDatabase, evidence: EvidenceId): Promise<string[]> =>
  (
    await admin<{ type: string }>(db, "select type from knowledge.claims where evidence_id = $1 order by type", [
      evidence,
    ])
  ).map((row) => row.type);

describe("a person's erasure reaches pages", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a dry run counts the block day and changes nothing; the erasure drops the page naming the person, remakes the researched claims and sets the day waiting", () =>
    withWorld(async (db) => {
      await commitResearched(db);
      const owner = createAdmin({
        url: db.urls.admin,
        keys: db.keys,
        log: eventLogger(),
        journal: journalPath(db.keyFile),
      });
      try {
        const dry = await owner.erasure.erasePerson(b().robin, { ...request(), dryRun: true });
        expect(dry.more.captures).toBe(1);
        expect(urlsOf(await workOf(db, DAY_ITEM.key, ["own"]))).toContain(`https://${DOCS}/robin`);
        expect(await claimsOf(db, b().split)).toEqual(["activity.researched"]);
        const done = await owner.erasure.erasePerson(b().robin, request());
        expect(done.more.captures).toBe(1);
      } finally {
        await owner.close();
      }
      const kept = urlsOf(await workOf(db, DAY_ITEM.key, ["own"]));
      expect(kept).not.toContain(`https://${DOCS}/robin`);
      expect(kept).toContain(`https://${DOCS}/alpha`);
      expect(await claimsOf(db, b().split)).toEqual([]);
      expect(
        one(
          await admin<{ waiting: boolean }>(db, "select waiting from vault.pipeline_items where evidence_id = $1", [
            b().split,
          ]),
        ).waiting,
      ).toBe(true);
    }));

  it("the erasure sticks: the work_enc catch-up refilling from the blob, which still names the person, and a new revision store the page again nowhere", () =>
    withWorld(async (db) => {
      const owner = createAdmin({
        url: db.urls.admin,
        keys: db.keys,
        log: eventLogger(),
        journal: journalPath(db.keyFile),
      });
      try {
        await owner.erasure.erasePerson(b().robin, request());
      } finally {
        await owner.close();
      }
      const log = eventLogger();
      const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
      const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
      try {
        // The vault original still names the person; the catch-up drops the suppressed page.
        expect(await blobPagesOf(db, b().split)).toContain(`https://${DOCS}/robin`);
        await admin(
          db,
          "update knowledge.captures set work_enc = null where capture_key = $1 and compartments = '{own}'",
          [DAY_ITEM.key],
        );
        expect((await writer.catchUpWork()).filled).toBe(1);
        const refilled = urlsOf(await workOf(db, DAY_ITEM.key, ["own"]));
        expect(refilled).not.toContain(`https://${DOCS}/robin`);
        expect(refilled).toContain(`https://${DOCS}/alpha`);
        const next = { ...DAY_ITEM, revision: 1 } as CaptureItem;
        expect(await reader.pushCapture(b().token, { batch: "pages-0002", items: [next] })).toEqual({
          ok: true,
          value: { items: [{ key: DAY_ITEM.key, outcome: "accepted" }] },
        });
        const taken = await writer.takeCapture();
        expect(urlsOf(await workOf(db, DAY_ITEM.key, ["own"]))).toEqual([
          `https://${DOCS}/alpha`,
          `https://${DOCS}/hidden`,
          `https://${SEARCH}/search alpha budget`,
        ]);
        expect(taken.dropped).toMatchObject({ page_erased: 1 });
      } finally {
        await reader.close();
        await writer.close();
      }
    }));

  it("a replay's hook, given the journal's fingerprints as addresses, drops the page from work_enc", () =>
    withWorld(async (db) => {
      const erased = {
        evidenceIds: [],
        refs: [],
        addressFps: [fingerprint(db.keys, "name", ROBIN)],
        sources: [],
        records: [],
        recordEvidenceIds: [],
        erasureId: null,
        factKeyFps: [],
        nameFps: [],
        claimKeys: [],
        claimIds: [],
      };
      await session(db.urls.admin, async (query) => {
        expect(await capturesErasure.run(query, erased, { dryRun: false, now: new Date(), keys: db.keys })).toBe(1);
      });
      expect(urlsOf(await workOf(db, DAY_ITEM.key, ["own"]))).not.toContain(`https://${DOCS}/robin`);
      expect(urlsOf(await workOf(db, DAY_ITEM.key, ["employer:example"]))).toEqual([`https://${CORP}/plan`]);
    }));
});
