import { randomBytes } from "node:crypto";
import type { Claim, EvidenceId } from "@intelligence/contracts";
import {
  ACTIVITY_PIPELINE,
  type BlockItem,
  type CaptureId,
  type CaptureItem,
  type ClaimRecord,
  type EntityId,
  type FactId,
  type FactList,
  MIRROR_QUOTA,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { afterAll, describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { sealRow } from "../core/seal.ts";
import { createReader } from "../read/read.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { copiesOf, createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { batchOf } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingLogger } from "../test-support/recording.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { createWriter } from "../write/writer.ts";
import { createPipeline } from "./pipeline.ts";

// Block days are pushed and drained as Lens and `pi sync` would; the activity claims are committed
// through the Pipeline as the block lane would hand them over, written out by hand (nothing of
// @intelligence/personal-extract is imported).
//
// One world, copied for each test: a device; Heron Survey (own) with a repository anchor; two
// block days: HERON, an editor's block in Heron's repository (git_remote) and a browser block on a
// docs host, under `own`, with a work editor's block in the same repository split off under
// `employer:example`; and BIRCH, a block in another repository. Reserved domains, made-up names.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;
const T = Math.floor(Date.now() / DAY_MS) * DAY_MS - 2 * DAY_MS;
const DAY = new Date(T).toISOString().slice(0, 10);
const at = (minutes: number): string => new Date(T + 13 * HOUR + minutes * MINUTE).toISOString();
const OWNER_ADDRESS = "quinn@example.org";
const EDITOR = { bundle: "test.example.activityeditor", name: "Editor" };
const WORK_EDITOR = { bundle: "test.example.activitywork", name: "Work editor" };
const CHROME = { bundle: "com.google.Chrome", name: "Chrome" };
const HERON_REPO = "github.com/example/heron";
const BIRCH_REPO = "github.com/example/birch";
const DOCS_HOST = "docs.example.org";

const repository = (value: string) => ({ value, method: "git_remote" as const, v: 1 });
const HERON: BlockItem = {
  kind: "block",
  key: "block:01JACTVDBA0000000000000001",
  revision: 0,
  day: DAY,
  blocks: [
    { start: at(0), end: at(30), minutes: 30, app: EDITOR, title: "heron", repository: repository(HERON_REPO) },
    { start: at(40), end: at(50), minutes: 10, app: CHROME, title: "Reference", host: DOCS_HOST },
    { start: at(60), end: at(80), minutes: 20, app: WORK_EDITOR, title: "heron", repository: repository(HERON_REPO) },
  ],
};
const BIRCH: BlockItem = {
  kind: "block",
  key: "block:01JACTVDBA0000000000000002",
  revision: 0,
  day: DAY,
  blocks: [
    { start: at(120), end: at(150), minutes: 30, app: EDITOR, title: "birch", repository: repository(BIRCH_REPO) },
  ],
};

type Built = {
  owner: string;
  heron: EntityId;
  anchor: string;
  anchorFp: string;
  splits: { heronOwn: EvidenceId; heronWork: EvidenceId; birch: EvidenceId };
  captures: { heronOwn: string };
};
let built: Built | undefined;
const b = (): Built => {
  if (built === undefined) throw new Error("the world is not built");
  return built;
};
const request = () => ({ requestId: `req-activity-${randomBytes(6).toString("hex")}` });
const admin = <Row = Record<string, unknown>>(db: TestDatabase, sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);

async function addDevice(db: TestDatabase): Promise<string> {
  const capture = { id: testId("cli"), token: `pit_test-activity-capture-${randomBytes(8).toString("hex")}` };
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
      sha256Hex(`pit_test-activity-mirror-${randomBytes(8).toString("hex")}`),
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

async function insertScope(
  db: TestDatabase,
  match: "bundle" | "host",
  value: string,
  compartment: string,
): Promise<void> {
  const id = testId("csr");
  const sealed = (column: string, text: string) =>
    sealRow(db.keys, "own", { table: "policy.capture_scope", id, column }, text);
  await admin(
    db,
    "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds) values ($1, $2, $3, $4, null, null, $5, '{block}')",
    [id, match, fingerprint(db.keys, "capture_scope", value), sealed("value_enc", value), compartment],
  );
}

// An activity claim as the block lane hands it over: the owner's, of ACTIVITY_PIPELINE, basis
// system_observed, the split's label, its span from and to.
function activityRecord(
  evidence: string,
  label: string[],
  owner: string,
  type: string,
  fields: Record<string, unknown>,
  span: { from: string; to: string },
  project?: string,
): ClaimRecord {
  const claim = {
    id: `${evidence.slice(0, 56)}${type.length.toString(16).padStart(4, "0")}${String(Object.keys(fields).length).padStart(4, "0")}`,
    content: { type, subject: owner, fields },
    statementKind: "stated_fact",
    basis: "system_observed",
    validFrom: span.from,
    validTo: span.to,
    evidence: [{ evidenceId: evidence, span: `activity:${type.slice(9)}:${span.from}` }],
    primaryEvidenceId: evidence,
    label: { compartments: label, readers: ["m-owner"] },
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
    factKey: `${type} ${owner} ${JSON.stringify(fields)}`,
    lane: "skip",
    fieldKinds: Object.fromEntries(
      Object.keys(fields).map((name) => [name, name === "project" ? "entity" : name === "category" ? "enum" : "text"]),
    ),
    entities: project === undefined ? [] : [project],
    origin: "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}
const skipped = { lane: "skip", status: "skipped", code: "not_extracted" } as const;

const world = copiesOf(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  const owner = createAdmin({ url: db.urls.admin, keys: db.keys, log, journal: journalPath(db.keyFile) });
  try {
    const token = await addDevice(db);
    await owner.accounts.addOwnerAddress(OWNER_ADDRESS, "own");
    await insertScope(db, "bundle", EDITOR.bundle, "own");
    await insertScope(db, "bundle", WORK_EDITOR.bundle, "employer:example");
    await insertScope(db, "host", DOCS_HOST, "own");
    const heron = await owner.projects.add("Heron Survey", request());
    const anchor = await owner.projects.anchor(heron, { kind: "repository", value: HERON_REPO }, request());
    const items = [HERON, BIRCH] as CaptureItem[];
    const answer = await reader.pushCapture(token, { batch: "activity-0001", items });
    expect(answer).toEqual({
      ok: true,
      value: { items: items.map((item) => ({ key: item.key, outcome: "accepted" })) },
    });
    expect(await writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
    const split = async (key: string, compartments: string[]): Promise<{ evidence: EvidenceId; id: string }> => {
      const row = one(
        await admin<{ evidence_id: EvidenceId; id: string }>(
          db,
          "select evidence_id, id from knowledge.captures where capture_key = $1 and compartments = $2",
          [key, compartments],
        ),
      );
      return { evidence: row.evidence_id, id: row.id };
    };
    const heronOwn = await split(HERON.key, ["own"]);
    const heronWork = await split(HERON.key, ["employer:example"]);
    const birch = await split(BIRCH.key, ["own"]);
    // Every split's work_enc is written at drain.
    expect(
      one(
        await admin<{ n: number }>(
          db,
          "select count(*)::int as n from knowledge.captures where kind = 'block' and work_enc is null",
        ),
      ).n,
    ).toBe(0);
    const ownerEntity = one(
      await admin<{ id: string }>(db, "select id from knowledge.entities where kind = 'owner'"),
    ).id;
    const anchorFp = one(
      await admin<{ anchor_fp: string }>(db, "select anchor_fp from knowledge.project_anchors where id = $1", [anchor]),
    ).anchor_fp;
    built = {
      owner: ownerEntity,
      heron,
      anchor,
      anchorFp,
      splits: { heronOwn: heronOwn.evidence, heronWork: heronWork.evidence, birch: birch.evidence },
      captures: { heronOwn: heronOwn.id },
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

// The three splits' claims, committed as the block lane would.
async function commitAll(db: TestDatabase): Promise<void> {
  const { owner, heron, splits } = b();
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  try {
    for (const id of Object.values(splits)) expect(await pipeline.openBlockDay(id)).not.toBeNull();
    expect(
      await pipeline.commit(
        batchOf(
          splits.heronOwn,
          [
            activityRecord(
              splits.heronOwn,
              ["own"],
              owner,
              "activity.worked_on",
              { project: heron },
              { from: at(0), to: at(30) },
              heron,
            ),
            activityRecord(
              splits.heronOwn,
              ["own"],
              owner,
              "activity.researched",
              { category: "other", host: DOCS_HOST },
              { from: at(40), to: at(50) },
            ),
          ],
          skipped,
        ),
      ),
    ).toBe("committed");
    expect(
      await pipeline.commit(
        batchOf(
          splits.heronWork,
          [
            activityRecord(
              splits.heronWork,
              ["employer:example"],
              owner,
              "activity.worked_on",
              { repository: HERON_REPO },
              { from: at(60), to: at(80) },
            ),
          ],
          skipped,
        ),
      ),
    ).toBe("committed");
    expect(
      await pipeline.commit(
        batchOf(
          splits.birch,
          [
            activityRecord(
              splits.birch,
              ["own"],
              owner,
              "activity.worked_on",
              { repository: BIRCH_REPO },
              { from: at(120), to: at(150) },
            ),
          ],
          skipped,
        ),
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
const waitingOf = async (db: TestDatabase, evidence: EvidenceId): Promise<boolean | undefined> =>
  (
    await admin<{ waiting: boolean }>(db, "select waiting from vault.pipeline_items where evidence_id = $1", [evidence])
  )[0]?.waiting;

describe("the store's half of the activity facts", { timeout: DB_TEST_TIMEOUT }, () => {
  it("openBlockDay gives a split's own blocks, their strong attributes alone with fingerprints that meet the anchor, and R107's candidates", async () => {
    await withWorld(async (db) => {
      const { splits, heron, anchorFp, owner } = b();
      const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
      try {
        const own = await pipeline.openBlockDay(splits.heronOwn);
        expect(own?.context).toMatchObject({ evidenceId: splits.heronOwn, compartments: ["own"], ownerEntity: owner });
        expect(own?.capture.day).toBe(DAY);
        expect(
          own?.blocks?.map((block) => [block.start, block.host, block.strong.map((one) => [one.kind, one.value])]),
        ).toEqual([
          [at(0), null, [["repository", HERON_REPO]]],
          [at(40), DOCS_HOST, []],
        ]);
        expect(own?.blocks?.[0]?.strong[0]?.keyFps).toContain(anchorFp);
        expect(own?.candidates).toEqual([{ project: heron, anchorFps: [anchorFp] }]);
        // The employer split is its own item: Heron (own) is no candidate of it.
        const work = await pipeline.openBlockDay(splits.heronWork);
        expect(work?.context.compartments).toEqual(["employer:example"]);
        expect(work?.blocks?.map((block) => block.start)).toEqual([at(60)]);
        expect(work?.candidates).toEqual([]);
        // A meeting's or a moment's evidence id, or a missing one, is no block day.
        expect(await pipeline.openBlockDay("e".repeat(64) as EvidenceId)).toBeNull();
      } finally {
        await pipeline.close();
      }
    });
  });

  it("the block lane's due list holds every split until it is committed, and not after", async () => {
    await withWorld(async (db) => {
      const { splits } = b();
      const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
      try {
        const due = async () =>
          (await pipeline.dueCaptures("block", 50, 1, { switchedOn: false })).map((one) => one.evidenceId).sort();
        expect(await due()).toEqual(Object.values(splits).sort());
        // No meeting or moment lane lists a block day.
        expect(
          (await pipeline.dueCaptures("meeting", 50, 1, { switchedOn: true })).map((one) => one.evidenceId),
        ).toEqual([]);
      } finally {
        await pipeline.close();
      }
      await commitAll(db);
      const again = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
      try {
        expect(await again.dueCaptures("block", 50, 1, { switchedOn: false })).toEqual([]);
        // A new generation takes them again.
        expect((await again.dueCaptures("block", 50, 2, { switchedOn: false })).length).toBe(3);
      } finally {
        await again.close();
      }
      expect(await claimsOf(db, splits.heronOwn)).toEqual(["activity.researched", "activity.worked_on"]);
      const [status] = await admin<{ screened: boolean; withheld: boolean }>(
        db,
        "select screened, withheld from vault.pipeline_items where evidence_id = $1",
        [splits.heronOwn],
      );
      expect(status).toEqual({ screened: false, withheld: false });
    });
  });

  it("lifting the anchor removes the matching block day's activity claims and sets it waiting; another compartment's split and another repository's day are untouched", async () => {
    await withWorld(async (db) => {
      await commitAll(db);
      const { splits, anchor } = b();
      const owner = createAdmin({
        url: db.urls.admin,
        keys: db.keys,
        log: eventLogger(),
        journal: journalPath(db.keyFile),
      });
      try {
        expect(await owner.projects.unanchor(anchor, request())).toBe(true);
      } finally {
        await owner.close();
      }
      expect(await claimsOf(db, splits.heronOwn)).toEqual([]);
      expect(await waitingOf(db, splits.heronOwn)).toBe(true);
      expect(await claimsOf(db, splits.heronWork)).toEqual(["activity.worked_on"]);
      expect(await waitingOf(db, splits.heronWork)).toBe(false);
      expect(await claimsOf(db, splits.birch)).toEqual(["activity.worked_on"]);
      expect(await waitingOf(db, splits.birch)).toBe(false);
    });
  });

  it("setting an anchor on another repository re-derives that day alone", async () => {
    await withWorld(async (db) => {
      await commitAll(db);
      const { splits, heron } = b();
      const owner = createAdmin({
        url: db.urls.admin,
        keys: db.keys,
        log: eventLogger(),
        journal: journalPath(db.keyFile),
      });
      try {
        await owner.projects.anchor(heron, { kind: "repository", value: BIRCH_REPO }, request());
      } finally {
        await owner.close();
      }
      expect(await waitingOf(db, splits.birch)).toBe(true);
      expect(await claimsOf(db, splits.birch)).toEqual([]);
      expect(await waitingOf(db, splits.heronOwn)).toBe(false);
      expect(await claimsOf(db, splits.heronOwn)).toEqual(["activity.researched", "activity.worked_on"]);
    });
  });

  it("erasing the item removes its activity claims", async () => {
    await withWorld(async (db) => {
      await commitAll(db);
      const { splits, captures } = b();
      const owner = createAdmin({
        url: db.urls.admin,
        keys: db.keys,
        log: eventLogger(),
        journal: journalPath(db.keyFile),
      });
      try {
        await owner.erasure.eraseItem({ kind: "capture", id: captures.heronOwn as CaptureId }, request());
      } finally {
        await owner.close();
      }
      expect(await claimsOf(db, splits.heronOwn)).toEqual([]);
      expect(await claimsOf(db, splits.birch)).toEqual(["activity.worked_on"]);
    });
  });

  it("find_facts serves an activity fact with its capture, its span's end, basis system_observed and tier observed, to a client cleared for its label alone", async () => {
    await withWorld(async (db) => {
      await commitAll(db);
      const client = async (name: string, compartments: string[]) => {
        const one = { id: testId("cli"), token: `pit_test-${name}-${randomBytes(6).toString("hex")}` };
        await admin(
          db,
          "insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools) values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6)",
          [one.id, name, sha256Hex(one.token), compartments, ["self", "people", "work"], ["find_facts"]],
        );
        return one;
      };
      const ownClient = await client("activity-own", ["own"]);
      const workClient = await client("activity-work", ["employer:example"]);
      const reader = createReader({ url: db.urls.reader, keys: db.keys, log: eventLogger() });
      try {
        // By type alone: find_facts never takes the owner's id (read-fact-rows' ENTITY), and these are the owner's.
        const facts = async (token: string): Promise<FactList> =>
          outcomeValue(await reader.findFacts(token, { type: "activity" }));
        const seen = (await facts(ownClient.token)).facts;
        expect(seen.map((fact) => [fact.type, fact.at]).sort()).toEqual(
          [
            ["activity.researched", at(40)],
            ["activity.worked_on", at(0)],
            ["activity.worked_on", at(120)],
          ].sort(),
        );
        for (const fact of seen) {
          expect(fact).toMatchObject({
            basis: "system_observed",
            tier: "observed",
            source: "screen",
            provenance: "source",
            agentReported: false,
            segment: null,
            message: null,
          });
          expect(fact.capture).not.toBeNull();
          expect("validTo" in fact && fact.validTo !== undefined).toBe(true);
        }
        const work = (await facts(workClient.token)).facts;
        expect(work.map((fact) => fact.at)).toEqual([at(60)]);
        const owner = createAdmin({ url: db.urls.admin, keys: db.keys, log: eventLogger() });
        try {
          for (const fact of seen) {
            const [claim] = await admin<{ id: FactId }>(
              db,
              "select id from knowledge.claims where type = $1 and valid_from = $2 and compartments = '{own}'",
              [fact.type, fact.at],
            );
            const detail = await owner.facts.show(claim?.id as FactId);
            expect(detail?.fact).toMatchObject({ type: fact.type, basis: "system_observed", message: null });
            expect(detail?.fact.capture).not.toBeNull();
            expect(detail?.fact.tier).toBe("observed");
            // No belief is built here, so the owner has no audience yet: a project keeps its id and no name.
            const fields = detail?.fact.fields as { project?: { name: unknown } } | undefined;
            const project = fields?.project;
            if (project !== undefined) expect(project.name).toBeNull();
          }
        } finally {
          await owner.close();
        }
      } finally {
        await reader.close();
      }
    });
  });

  it("the device's view counts its activity claims by day", async () => {
    await withWorld(async (db) => {
      await commitAll(db);
      const owner = createAdmin({
        url: db.urls.admin,
        keys: db.keys,
        log: eventLogger(),
        journal: journalPath(db.keyFile),
      });
      try {
        const [device] = await owner.lens.devices();
        expect(device?.activity).toEqual([{ day: DAY, count: 4 }]);
      } finally {
        await owner.close();
      }
    });
  });
});
