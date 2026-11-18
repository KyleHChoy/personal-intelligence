import { randomBytes } from "node:crypto";
import type { Claim, EvidenceId, ModelCallRecord } from "@intelligence/contracts";
import {
  BELIEF_TYPES,
  type CaptureItem,
  type CardId,
  type ClaimRecord,
  type EntityId,
  type MeetingItem,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { afterAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { openUnder, sealRow } from "../core/seal.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { createReader } from "../read/read.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { copiesOf, createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { batchOf, beliefsComputed, claimRecord, rowsOf } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingLogger } from "../test-support/recording.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { createWriter } from "../write/writer.ts";

// The re-check when a device anchor is set or lifted. The owner's `anchorProject` and
// `unanchorProject` run as pi_admin; the claims the re-check acts on are committed through the
// Pipeline as the lanes would hand them over, written out by hand (nothing of
// @intelligence/personal-extract is imported); a group's saved call is saved as the moment lane
// saves one. What the next run makes of each item is apps/pi/src/intake/lens-link.db.test.ts's.
//
// One world, built once and copied for each test (copiesOf): a device registered by hand; three
// projects, Heron Survey (own) with a host and an app anchor, Rival Survey (own) with none, and
// Wharf Ledger (employer:example) with none; and seven capture items, each committed with a plan
// claim, the claim a lane makes beside its link: two moments of one group on Heron's host and
// elsewhere, the group's call saved under the first; a moment on Heron's host with no saved call;
// a meeting on Heron's app; a browser meeting on Heron's host that ended withheld; a browser
// meeting on another host, linked to Rival Survey by its title, the owner having confirmed it;
// and an employer:example moment on Heron's host. Reserved domains, synthetic names.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const MODEL = "configured/model";

const HERON_APP = { bundle: "test.example.heronapp", name: "Heron" };
const READER = { bundle: "test.example.anchorreader", name: "Reader" };
const WORK_READER = { bundle: "test.example.anchorwork", name: "Work reader" };
const CHROME = { bundle: "com.google.Chrome", name: "Chrome" };
const WORK_ACCOUNT = "quinn@work.example.com";
const OWNER_ADDRESS = "quinn@example.org";

let keys = 0;
const keyOf = <K extends "meeting" | "moment">(kind: K): `${K}:${string}` =>
  `${kind}:01JQ1NKA${String((keys += 1)).padStart(18, "0")}`;
const meeting = (start: number, over: Partial<MeetingItem>): MeetingItem => ({
  kind: "meeting",
  key: keyOf("meeting"),
  revision: 0,
  startedAt: local(start),
  endedAt: local(start + 30 * MINUTE),
  app: HERON_APP,
  title: "Design review",
  consent: true,
  mode: "call",
  speakers: [],
  segments: [{ speaker: null, fromMs: 0, toMs: 20_000, channel: "mixed", text: "Shall we start?" }],
  ...over,
});
const moment = (start: number, thread: string, over: Partial<MomentItem>): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: local(start),
  endedAt: local(start + 2 * MINUTE),
  app: READER,
  entity: "doc",
  thread,
  participants: [],
  text: "The plan, second draft.",
  read: "ax",
  ...over,
});

const ITEMS = {
  // One group: the same bundle, thread and local day.
  GA: moment(-40 * HOUR, "Group", { url: "https://heron.example.org/a" }),
  // A chat moment, so it could still enter the moment lane when its group is widened in.
  GB: moment(-40 * HOUR + 5 * MINUTE, "Group", { url: "https://other.example.net/b", entity: "chat" }),
  GC: moment(-38 * HOUR, "Solo", { url: "https://heron.example.org/c" }),
  M1: meeting(-36 * HOUR, {}),
  W: meeting(-34 * HOUR, { app: CHROME, host: "heron.example.org", title: "Withheld call" }),
  TL: meeting(-32 * HOUR, { app: CHROME, host: "titles.example.org", title: "Rival Survey notes" }),
  E1: moment(-30 * HOUR, "Work", { app: WORK_READER, url: "https://heron.example.org/x", account: WORK_ACCOUNT }),
};
type Name = keyof typeof ITEMS;
const NAMES = Object.keys(ITEMS) as Name[];

type Built = {
  owner: string;
  evidence: Record<Name, EvidenceId>;
  projects: { heron: EntityId; rival: EntityId; wharf: EntityId };
  anchors: { host: string; app: string };
  claims: Record<Name, { plan: string; link: string | null }>;
};
let built: Built | undefined;
const b = (): Built => {
  if (built === undefined) throw new Error("the world is not built");
  return built;
};
const request = () => ({ requestId: `req-lens-anchors-${randomBytes(6).toString("hex")}` });
const admin = <Row = Record<string, unknown>>(db: TestDatabase, sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);

async function addDevice(db: TestDatabase): Promise<string> {
  const capture = { id: testId("cli"), token: `pit_test-anchors-capture-${randomBytes(8).toString("hex")}` };
  const mirror = testId("cli");
  const insertClient = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
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
      sha256Hex(`pit_test-anchors-mirror-${randomBytes(8).toString("hex")}`),
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
  kinds: string[],
  account?: string,
): Promise<void> {
  const id = testId("csr");
  const sealed = (column: string, text: string) =>
    sealRow(db.keys, "own", { table: "policy.capture_scope", id, column }, text);
  await admin(
    db,
    "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      id,
      match,
      fingerprint(db.keys, "capture_scope", value),
      sealed("value_enc", value),
      account === undefined ? null : fingerprint(db.keys, "capture_scope", account),
      account === undefined ? null : sealed("account_enc", account),
      compartment,
      kinds,
    ],
  );
}

// A link claim as a lane hands it over: see lens-link.db.test.ts's linkRecord.
function linkRecord(name: Name, evidence: string, label: string[], project: string, anchor?: string): ClaimRecord {
  const item = ITEMS[name];
  const type = anchor === undefined ? "capture.project" : "capture.anchor";
  const claim = {
    id: sha256(`link ${evidence} ${type}`),
    content: { type, subject: project, fields: anchor === undefined ? {} : { anchor } },
    statementKind: "stated_fact",
    basis: "third_party",
    validFrom: new Date(Date.parse(item.kind === "meeting" ? item.startedAt : item.observedAt)).toISOString(),
    evidence: [{ evidenceId: evidence, span: "capture:link" }],
    primaryEvidenceId: evidence,
    label: { compartments: label, readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: "lens-link-1",
    extractorGeneration: 1,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  return {
    claim,
    subjectKind: "project",
    disclosure: [],
    factKey: `${type} ${project} ${item.key}`,
    lane: item.kind,
    fieldKinds: anchor === undefined ? {} : { anchor: "text" },
    entities: [],
    origin: "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}
const planRecord = (evidence: string, label: string[], owner: string): ClaimRecord =>
  claimRecord(evidence, label, owner, { n: 3, type: "plan", basis: "third_party" });

// A group's saved call, keyed under its first moment, as the moment lane saves one.
const groupCall = (evidenceId: string): ModelCallRecord =>
  ({
    key: {
      evidenceId,
      revision: 0,
      extractorGeneration: 0,
      promptId: "personal_moment",
      promptVersion: "1",
      inputHash: "c".repeat(64),
    },
    keys: [{ evidenceId, keyRef: "personal-unsealed" }],
    renderedInput: "",
    rawOutput: JSON.stringify({ claims: [], narrowing: "none" }),
    outputHash: "d".repeat(64),
    label: { compartments: ["own"], readers: ["m-owner"] },
    origin: "live",
  }) as unknown as ModelCallRecord;

// The beliefs `own` is given now that rest on this stored claim: computed when asked.
const resting = async (db: TestDatabase, claim: string): Promise<string[]> =>
  (await beliefsComputed(db, ["own"], BELIEF_TYPES, new Date().toISOString()))
    .filter((one) => one.belief.support.some((id) => fingerprint(db.keys, "claim", id) === claim))
    .map((one) => one.factKeyFp);

const world = copiesOf(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  const owner = createAdmin({ url: db.urls.admin, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  try {
    const token = await addDevice(db);
    // The owner's entity, which a box has once its owner's address is known: the plans' subject,
    // and what the moment lane opens a group with.
    await owner.accounts.addOwnerAddress(OWNER_ADDRESS, "own");
    await insertScope(db, "bundle", READER.bundle, "own", ["moment"]);
    await insertScope(db, "bundle", HERON_APP.bundle, "own", ["meeting"]);
    // The employer moment shares Heron's host with own moments, so its rule names its account, and
    // a rule with an account wins over one without.
    await insertScope(db, "host", "heron.example.org", "own", ["meeting", "moment"]);
    await insertScope(db, "host", "other.example.net", "own", ["moment"]);
    await insertScope(db, "host", "titles.example.org", "own", ["meeting"]);
    await insertScope(db, "host", "heron.example.org", "employer:example", ["moment"], WORK_ACCOUNT);
    await insertScope(db, "bundle", WORK_READER.bundle, "employer:example", ["moment"]);
    const projects = {
      heron: await owner.projects.add("Heron Survey", request()),
      rival: await owner.projects.add("Rival Survey", request()),
      wharf: await owner.projects.add("Wharf Ledger", { compartment: "employer:example", ...request() }),
    };
    const anchors = {
      host: await owner.projects.anchor(projects.heron, { kind: "host", value: "heron.example.org" }, request()),
      app: await owner.projects.anchor(projects.heron, { kind: "app", value: HERON_APP.bundle }, request()),
    };
    const items = NAMES.map((name) => ITEMS[name]) as CaptureItem[];
    const answer = await reader.pushCapture(token, { batch: "lens-link-anchors-0001", items });
    expect(answer).toEqual({
      ok: true,
      value: { items: items.map((item) => ({ key: item.key, outcome: "accepted" })) },
    });
    expect(await writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
    const evidence = {} as Record<Name, EvidenceId>;
    for (const name of NAMES) {
      const row = one(
        await admin<{ evidence_id: EvidenceId; compartments: string[] }>(
          db,
          "select evidence_id, compartments from knowledge.captures where capture_key = $1",
          [ITEMS[name].key],
        ),
      );
      expect(row.compartments, name).toEqual(name === "E1" ? ["employer:example"] : ["own"]);
      evidence[name] = row.evidence_id;
    }
    const ownerEntity = one(
      await admin<{ id: string }>(db, "select id from knowledge.entities where kind = 'owner'"),
    ).id;

    // What the lanes left: each item's plan and its link, after the anchors were set.
    const links: Record<Name, ClaimRecord | null> = {
      GA: linkRecord("GA", evidence.GA, ["own"], projects.heron, anchors.host),
      GB: null,
      GC: linkRecord("GC", evidence.GC, ["own"], projects.heron, anchors.host),
      M1: linkRecord("M1", evidence.M1, ["own"], projects.heron, anchors.app),
      W: linkRecord("W", evidence.W, ["own"], projects.heron, anchors.host),
      TL: linkRecord("TL", evidence.TL, ["own"], projects.rival),
      E1: null,
    };
    const claims = {} as Built["claims"];
    for (const name of NAMES) {
      const label = name === "E1" ? ["employer:example"] : ["own"];
      const plan = planRecord(evidence[name], label, ownerEntity);
      const link = links[name];
      const lane = ITEMS[name].kind;
      if (name === "GA" || name === "GB") {
        for (const id of [evidence.GA, evidence.GB]) expect(await pipeline.openMoment(id)).not.toBeNull();
      }
      const outcome =
        name === "W"
          ? { status: "withheld", code: "quarantine" }
          : name === "GA" || name === "GB"
            ? { status: "done" }
            : { status: "skipped", code: "not_extracted" };
      expect(
        await pipeline.commit(
          batchOf(evidence[name], [plan, ...(link === null ? [] : [link])], { lane, ...outcome } as never),
        ),
        name,
      ).toBe("committed");
      // Each under its stored id, the keyed fingerprint of its record id.
      claims[name] = {
        plan: fingerprint(db.keys, "claim", plan.claim.id),
        link: link === null ? null : fingerprint(db.keys, "claim", link.claim.id),
      };
    }
    await pipeline.calls(MODEL, [evidence.GA, evidence.GB]).save(groupCall(evidence.GA));
    // The owner confirmed the title link, and a belief rests on it.
    const [card] = await admin<{ id: CardId }>(db, "select id from ledger.cards where kind = 'agent_claim'");
    if (card === undefined) throw new Error("no card for the title link");
    await owner.cards.decide({ cards: [card.id], answer: "confirm", requestId: testId("req").slice(4) });
    built = { owner: ownerEntity, evidence, projects, anchors, claims };
  } finally {
    await pipeline.close();
    await owner.close();
    await reader.close();
    await writer.close();
  }
  return db;
});

afterAll(async () => {
  await world.drop();
}, DB_TEST_TIMEOUT);

type Copy = { db: TestDatabase; owner: Admin; pipeline: Pipeline };
async function withWorld(fn: (copy: Copy) => Promise<void>): Promise<void> {
  const db = await world.copy();
  const owner = createAdmin({
    url: db.urls.admin,
    keys: db.keys,
    log: eventLogger(),
    journal: journalPath(db.keyFile),
  });
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  try {
    await fn({ db, owner, pipeline });
  } finally {
    await pipeline.close();
    await owner.close();
    await db.drop();
  }
}

type State = { claims: string[]; waiting: boolean; withheld: boolean; calls: number };
async function stateOf(db: TestDatabase, name: Name): Promise<State> {
  const evidence = b().evidence[name];
  const claims = (
    await admin<{ id: string }>(db, "select id from knowledge.claims where evidence_id = $1 order by id", [evidence])
  ).map((row) => row.id);
  const [item] = await admin<{ waiting: boolean; withheld: boolean }>(
    db,
    "select waiting, withheld from vault.pipeline_items where evidence_id = $1",
    [evidence],
  );
  const calls = one(
    await admin<{ n: number }>(db, "select count(*)::int as n from vault.model_calls where evidence_id = $1", [
      evidence,
    ]),
  ).n;
  return { claims, waiting: item?.waiting ?? false, withheld: item?.withheld ?? false, calls };
}
async function statesOf(db: TestDatabase): Promise<Record<Name, State>> {
  const states = {} as Record<Name, State>;
  for (const name of NAMES) states[name] = await stateOf(db, name);
  return states;
}
const counts = async (db: TestDatabase) =>
  one(
    await admin<{ decisions: number; anchors: number }>(
      db,
      "select (select count(*)::int from knowledge.owner_decisions) as decisions, (select count(*)::int from knowledge.project_anchors where lifted_at is null) as anchors",
    ),
  );
const without = (claims: string[], id: string | null): string[] => claims.filter((one_) => one_ !== id);
const statusFacts = async (db: TestDatabase, evidenceId: string): Promise<Record<string, unknown>> => {
  const row = one(
    await admin<{ facts_enc: unknown; compartments: string[] }>(
      db,
      "select facts_enc, compartments from vault.pipeline_items where evidence_id = $1",
      [evidenceId],
    ),
  );
  return JSON.parse(
    openUnder(
      db.keys,
      row.compartments,
      { table: "vault.pipeline_items", id: evidenceId, column: "facts_enc" },
      row.facts_enc as never,
    ),
  ) as Record<string, unknown>;
};

describe("the re-check when a device anchor is set or lifted", { timeout: DB_TEST_TIMEOUT }, () => {
  it("Deletion and the owner's changes. Lifting a device anchor removes only the link claims of the items whose match keys hold it and whose compartments hold the project's, and sets each waiting with its saved calls kept", () =>
    withWorld(async ({ db, owner }) => {
      const before = await statesOf(db);
      for (const name of NAMES) expect(before[name].waiting, name).toBe(false);
      expect(await owner.projects.unanchor(b().anchors.host, request())).toBe(true);
      const after = await statesOf(db);
      // The host's items: their link gone, every other claim in place, set waiting.
      for (const name of ["GA", "GC"] as const) {
        expect(after[name].claims, name).toEqual(without(before[name].claims, b().claims[name].link));
        expect(after[name].claims, name).toContain(b().claims[name].plan);
        expect(after[name].waiting, name).toBe(true);
      }
      // The group's call is kept, under its first moment.
      expect(after.GA.calls).toBe(1);
      expect(before.GA.calls).toBe(1);
      // The item with no saved call is set waiting all the same.
      expect(before.GC.calls).toBe(0);
      // The controls: the meeting on Heron's app, the employer moment on Heron's host (outside the
      // project's compartments) and the title-linked meeting on another host are untouched.
      for (const name of ["M1", "E1", "TL"] as const) expect(after[name], name).toEqual(before[name]);
      // Nothing outside the link claims went: no plan, of any item.
      for (const name of NAMES) expect(after[name].claims, name).toContain(b().claims[name].plan);
    }));

  it("a moment's whole group is set waiting with it", () =>
    withWorld(async ({ db, owner }) => {
      // Rival Survey's prefix over GA's page alone: GA and the rest of its group wait.
      await owner.projects.anchor(
        b().projects.rival,
        { kind: "url_prefix", value: "https://heron.example.org/a" },
        request(),
      );
      const after = await statesOf(db);
      expect([after.GA.waiting, after.GB.waiting]).toEqual([true, true]);
      // GA's link goes; GB had none, and keeps its plan.
      expect(after.GA.claims).toEqual([b().claims.GA.plan]);
      expect(after.GB.claims).toEqual([b().claims.GB.plan]);
      expect(after.GA.calls).toBe(1);
      // The control: the moment on Heron's host the prefix does not reach is not set waiting.
      expect(after.GC.waiting).toBe(false);
      expect(after.GC.claims).toContain(b().claims.GC.link);
    }));

  // A moment only widened in waits only when it could still enter the moment lane: not one of an
  // agent app, nor one already skipped for what it lacks.
  it("a moment of an agent app widened in is not set waiting", () =>
    withWorld(async ({ db, owner }) => {
      await admin(db, "update knowledge.captures set agent_app = true where evidence_id = $1", [b().evidence.GB]);
      await owner.projects.anchor(
        b().projects.rival,
        { kind: "url_prefix", value: "https://heron.example.org/a" },
        request(),
      );
      expect([(await stateOf(db, "GA")).waiting, (await stateOf(db, "GB")).waiting]).toEqual([true, false]);
    }));

  it("a moment widened in that is already skipped for what it lacks is not set waiting", () =>
    withWorld(async ({ db, owner, pipeline }) => {
      expect(
        await pipeline.commit(
          batchOf(b().evidence.GB, [], { lane: "skip", status: "skipped", code: "no_turns", keep: true }),
        ),
      ).toBe("committed");
      await owner.projects.anchor(
        b().projects.rival,
        { kind: "url_prefix", value: "https://heron.example.org/a" },
        request(),
      );
      expect([(await stateOf(db, "GA")).waiting, (await stateOf(db, "GB")).waiting]).toEqual([true, false]);
      // It kept its plan through that commit.
      expect((await stateOf(db, "GB")).claims).toEqual([b().claims.GB.plan]);
    }));

  // A done moment the re-check sets waiting, then committed skipped for what it lacks (no_turns, as
  // an older moment is), keeps the claims its model made; only its link becomes the batch's. The
  // owner's retry, and only it, removes them.
  it("anchoring keeps a done moment's claims through its skipped re-commit; a retry removes them at the next", () =>
    withWorld(async ({ db, owner, pipeline }) => {
      await owner.projects.anchor(
        b().projects.rival,
        { kind: "url_prefix", value: "https://heron.example.org/a" },
        request(),
      );
      const waiting = await stateOf(db, "GA");
      expect(waiting).toMatchObject({ claims: [b().claims.GA.plan], waiting: true });
      const skipped = batchOf(b().evidence.GA, [], { lane: "skip", status: "skipped", code: "no_turns", keep: true });
      expect(await pipeline.commit(skipped)).toBe("committed");
      expect(await stateOf(db, "GA")).toMatchObject({ claims: [b().claims.GA.plan], waiting: false });
      expect(await statusFacts(db, b().evidence.GA)).toMatchObject({ status: "skipped", code: "no_turns", claims: 1 });
      // A link the batch carries replaces the stored one; the model's plan stays beside it.
      const link = linkRecord("GA", b().evidence.GA, ["own"], b().projects.heron, b().anchors.host);
      expect(await pipeline.commit({ ...skipped, claims: [link] })).toBe("committed");
      expect((await stateOf(db, "GA")).claims).toEqual(
        [b().claims.GA.plan, fingerprint(db.keys, "claim", link.claim.id)].sort(),
      );
      // `keep` is a moment's skipped commit's alone.
      await expect(pipeline.commit({ ...skipped, status: "done", code: undefined })).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await expect(
        pipeline.commit(batchOf(b().evidence.M1, [], { lane: "skip", status: "skipped", code: "no_text", keep: true })),
      ).rejects.toMatchObject({ code: "invalid_argument" });

      // `pia extract retry` of the moment: the same commit now replaces every claim, and the mark clears.
      expect(await owner.extraction.retry({ capture: ITEMS.GA.key })).toEqual({ selected: 1 });
      expect(await statusFacts(db, b().evidence.GA)).toMatchObject({ status: "waiting", retried: true });
      // A defer before the commit keeps the retry.
      await pipeline.defer(b().evidence.GA, 1, { code: "model_unavailable", lane: "moment" });
      expect(await statusFacts(db, b().evidence.GA)).toMatchObject({ retried: true });
      expect(await pipeline.commit(skipped)).toBe("committed");
      expect((await stateOf(db, "GA")).claims).toEqual([]);
      expect(await statusFacts(db, b().evidence.GA)).not.toHaveProperty("retried");
    }));

  it("a withheld item is not set waiting", () =>
    withWorld(async ({ db, owner }) => {
      const before = await stateOf(db, "W");
      expect(before.withheld).toBe(true);
      expect(await owner.projects.unanchor(b().anchors.host, request())).toBe(true);
      const after = await stateOf(db, "W");
      // Its link goes with the anchor's, but it waits for the owner's retry.
      expect(after.claims).toEqual(without(before.claims, b().claims.W.link));
      expect(after.waiting).toBe(false);
      expect(after.withheld).toBe(true);
      // The control: the moment beside it on the same host is set waiting.
      expect((await stateOf(db, "GC")).waiting).toBe(true);
    }));

  it("the item's other claims stay in place from the change to the next commit", () =>
    withWorld(async ({ db, owner, pipeline }) => {
      const before = await statesOf(db);
      await owner.projects.unanchor(b().anchors.host, request());
      const changed = await statesOf(db);
      for (const name of NAMES) expect(changed[name].claims, name).toContain(b().claims[name].plan);
      // The next commit of a waiting item, by replay, keeps the plan and drops none but what it leaves out.
      const plan = planRecord(b().evidence.GC, ["own"], b().owner);
      expect(fingerprint(db.keys, "claim", plan.claim.id)).toBe(b().claims.GC.plan);
      expect(
        await pipeline.commit(
          batchOf(b().evidence.GC, [plan], { lane: "moment", status: "skipped", code: "not_extracted" } as never),
        ),
      ).toBe("committed");
      const committed = await stateOf(db, "GC");
      expect(committed.claims).toEqual([b().claims.GC.plan]);
      expect(committed.waiting).toBe(false);
      expect(before.GC.claims).toEqual([b().claims.GC.plan, b().claims.GC.link].sort());
    }));

  it("setting an anchor that a title-linked meeting now meets removes its title link with the belief resting on it", () =>
    withWorld(async ({ db, owner, pipeline }) => {
      const title = b().claims.TL.link ?? "";
      expect(await resting(db, title)).toHaveLength(1);
      expect(
        (await pipeline.beliefClaims()).some((group) =>
          group.claims.some((one_) => fingerprint(db.keys, "claim", one_.claim.id) === title),
        ),
      ).toBe(true);
      await owner.projects.anchor(b().projects.heron, { kind: "host", value: "titles.example.org" }, request());
      const after = await stateOf(db, "TL");
      expect(after.claims).toEqual([b().claims.TL.plan]);
      expect(after.waiting).toBe(true);
      expect(await resting(db, title)).toEqual([]);
      expect(
        (await pipeline.beliefClaims()).some((group) =>
          group.claims.some((one_) => fingerprint(db.keys, "claim", one_.claim.id) === title),
        ),
      ).toBe(false);
      // Its card stays, answered: the next commit's title link, if any, asks nothing again.
      expect(await rowsOf(db, "select id from ledger.cards where kind = 'agent_claim'")).toHaveLength(1);
    }));

  it("an employer:example project's anchor re-checks only the items whose compartments hold the project's", () =>
    withWorld(async ({ db, owner }) => {
      const before = await statesOf(db);
      await owner.projects.anchor(
        b().projects.wharf,
        { kind: "url_prefix", value: "https://heron.example.org/x" },
        request(),
      );
      const after = await statesOf(db);
      expect(after.E1.waiting).toBe(true);
      expect(after.E1.claims).toEqual(before.E1.claims);
      for (const name of NAMES.filter((one_) => one_ !== "E1")) expect(after[name], name).toEqual(before[name]);
    }));

  it("both answer extract_running while a run holds the lock, and write nothing", () =>
    withWorld(async ({ db, owner, pipeline }) => {
      const before = { counts: await counts(db), states: await statesOf(db) };
      const held = await pipeline.withExtractLock(async () => {
        await expect(
          owner.projects.anchor(b().projects.rival, { kind: "host", value: "rival.example.org" }, request()),
        ).rejects.toMatchObject({ code: "extract_running" });
        await expect(owner.projects.unanchor(b().anchors.host, request())).rejects.toMatchObject({
          code: "extract_running",
        });
        return "held";
      });
      expect(held).toBe("held");
      expect({ counts: await counts(db), states: await statesOf(db) }).toEqual(before);
      // The control: with the lock free, both are taken.
      expect(
        await owner.projects.anchor(b().projects.rival, { kind: "host", value: "rival.example.org" }, request()),
      ).toMatch(/^pan_/);
      expect(await owner.projects.unanchor(b().anchors.host, request())).toBe(true);
    }));
});
