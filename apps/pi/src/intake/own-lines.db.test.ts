import { createHash, randomBytes } from "node:crypto";
import type { ModelRequest } from "@intelligence/contracts";
import { type FactList, MIRROR_QUOTA, type MomentItem, QUOTA_DEFAULTS } from "@intelligence/contracts/personal";
import {
  type ExtractDeps,
  OWN_LINES_DAY_MICRO_USD,
  runExtraction,
  runOwnLinesTrial,
} from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  journalPath,
} from "@intelligence/personal-store";
import {
  asTablesOwner,
  createTestDatabase,
  DB_TEST_TIMEOUT,
  queryAs,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MODEL_ID, quiet } from "../test-support/extract-fixtures.ts";

// The own-lines lane on the database: a moment pushed as Lens is to push it, an agent-app rule's,
// drained, and extracted as `pi extract` runs it, with the fake model answering. What the unit tests
// of the lane cannot show: the claim keeps the moment's label as the store labels it (invariant 4), it
// is served with its own mark and builds a belief as the owner's word, and an erasure takes the claim
// and the saved call, and a later run does not bring them back (invariant 10). Reserved domains and
// test bundles only; no real model is called.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const AGENT_APP = { bundle: "test.example.agent", name: "Agent" };
const DESK = ["agent:desk", "own"];
const LINE = "I want to open a bakery, and I am moving to Denver in May for it.";
const REPLY = "Noted. You want to sail around the world, and your goal is to buy a boat.";
const TEXT = `${LINE}\n${REPLY}`;
const SPAN = `mom:0:0-${LINE.length}`;
const ITEM: MomentItem = {
  kind: "moment",
  key: "moment:01JPKNSMMNT000000000000001",
  revision: 0,
  observedAt: local(-3 * HOUR),
  endedAt: local(-3 * HOUR + MINUTE),
  app: AGENT_APP,
  entity: "chat",
  thread: "Planning",
  participants: [],
  text: TEXT,
  read: "ax",
  turns: [
    { from: 0, to: LINE.length, speaker: "owner" },
    { from: LINE.length + 1, to: TEXT.length, speaker: "agent" },
  ],
};

let db: TestDatabase;
let owner: Admin;
let deskToken: string;
let evidence: string;
let captureId: string;
const admin = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);
const idOf = (prefix: string): string =>
  `${prefix}_01JPKNSM${randomBytes(9)
    .toString("hex")
    .toUpperCase()
    .replace(/[ILOU]/g, "X")
    .slice(0, 18)}`;

async function addDevice(): Promise<string> {
  const token = `pit_test-mac-${randomBytes(8).toString("hex")}`;
  const capture = idOf("cli");
  const mirror = idOf("cli");
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  await admin(insert, [
    capture,
    "mac-capture",
    sha256Hex(token),
    ["own"],
    ["self"],
    ["push_capture"],
    "device",
    ...quota(QUOTA_DEFAULTS.device),
  ]);
  await admin(insert, [
    mirror,
    "mac",
    sha256Hex(`pit_test-mirror-${randomBytes(8).toString("hex")}`),
    ["own"],
    ["self", "people", "work"],
    ["sync_mirror"],
    "agent",
    ...quota(MIRROR_QUOTA),
  ]);
  await admin("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
    "mac",
    capture,
    mirror,
  ]);
  for (const [connector, kind] of [
    ["lens_meetings", "transcript"],
    ["lens_activity", "screen_activity"],
    ["lens_blocks", "time_block"],
  ] as const) {
    await admin(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', $2, $3, '{own}')",
      [idOf("acc"), connector, kind],
    );
  }
  return token;
}

const answerOf = (): Record<string, unknown> => ({
  [evidence]: {
    claims: [
      {
        type: "goal",
        subject: {
          key: { kind: "source_id", value: "speaker:owner" },
          observedAt: new Date(T - 3 * HOUR).toISOString(),
        },
        fields: { objective: "open a bakery", domain: "ventures" },
        statementKind: "stated_fact",
        basis: "explicit_self",
        span: SPAN,
      },
    ],
    narrowing: "none",
  },
});

async function extract(ownLines: boolean): Promise<{ asked: string[]; requests: ModelRequest[] }> {
  const asked: string[] = [];
  const requests: ModelRequest[] = [];
  const fake = fakeModelClient(answerOf(), asked);
  const model: ExtractDeps["model"] = {
    complete: (request) => {
      requests.push(request);
      return fake.complete(request);
    },
    embed: (request) => fake.embed(request),
  };
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
  try {
    const summary = await runExtraction({
      store: pipeline,
      model,
      modelId: MODEL_ID,
      log: quiet,
      now: () => new Date(T),
      compartments: [...DESK],
      moments: true,
      momentsContinuous: true,
      ...(ownLines ? { ownLines: { dayMicroUsd: OWN_LINES_DAY_MICRO_USD } } : {}),
    });
    if (summary === "already_running") throw new Error("locked");
    return { asked, requests };
  } finally {
    await pipeline.close();
  }
}

// The trial, with the moment committed `agent_app`, as it runs with the switch off.
async function trial(): Promise<void> {
  const asked: string[] = [];
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
  try {
    await runOwnLinesTrial(
      { store: pipeline, model: fakeModelClient(answerOf(), asked), modelId: MODEL_ID, compartments: [...DESK] },
      5,
    );
  } finally {
    await pipeline.close();
  }
  expect(asked).toEqual([evidence]);
}
const yieldLine = async () => {
  const view = await owner.box.outcomes(30);
  const line = view.metrics.find((one: { metric: string }) => one.metric === "own_lines_claims_per_moment");
  if (line === undefined) throw new Error("no line");
  return line;
};

const claimRows = (): Promise<{ id: string; type: string; compartments: string[] }[]> =>
  admin("select id, type, compartments from knowledge.claims where evidence_id = $1 and type = 'goal'", [evidence]);
const savedCalls = async (): Promise<number> =>
  (
    await admin<{ n: number }>("select count(*)::int as n from vault.model_call_members where evidence_id = $1", [
      evidence,
    ])
  )[0]?.n ?? 0;

beforeAll(async () => {
  db = await createTestDatabase({ compartments: ["own", "agent:desk"] });
  owner = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet, journal: journalPath(db.keyFile) });
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
  try {
    // The owner's account, so the owner entity exists.
    await writer.ensureSourceAccount("personal", "google_mail", "own", "owner@quinn.test");
    const token = await addDevice();
    deskToken = `pit_test-desk-${randomBytes(8).toString("hex")}`;
    await admin(
      `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
       values ($1, 'desk', $2, 'active', 'none', 'local', $3, $4, $5)`,
      [idOf("cli"), sha256Hex(deskToken), DESK, ["self", "people", "work"], ["find_facts", "get_self"]],
    );
    await owner.lens.addScope({
      match: "bundle",
      value: AGENT_APP.bundle,
      compartment: "own",
      kinds: ["moment"],
      agentApp: true,
      client: "desk",
    });
    expect(await reader.pushCapture(token, { batch: "pi-own-lines-0001", items: [ITEM] })).toEqual({
      ok: true,
      value: { items: [{ key: ITEM.key, outcome: "accepted" }] },
    });
    expect(await writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
  } finally {
    await reader.close();
    await writer.close();
  }
  const [row] = await admin<{ id: string; evidence_id: string }>(
    "select id, evidence_id from knowledge.captures where capture_key = $1",
    [ITEM.key],
  );
  captureId = row?.id ?? "";
  evidence = row?.evidence_id ?? "";
  expect(evidence).not.toBe("");
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await owner?.close();
  await db?.drop();
});

describe("the own-lines lane on the database", { timeout: DB_TEST_TIMEOUT }, () => {
  it("off, the moment is committed agent_app with no call and no claim", async () => {
    const { asked } = await extract(false);
    expect(asked).toEqual([]);
    expect(await claimRows()).toEqual([]);
  });

  it("the outcome line has no data before the lane takes a moment, a trial's call and all", async () => {
    await trial();
    expect(await yieldLine()).toMatchObject({ sample: 0, state: "no_data" });
    expect(await claimRows()).toEqual([]);
    // As `pi extract retry --capture` sets it, so the switch takes the moment committed before it.
    expect(await owner.extraction.retry({ capture: captureId }, {})).toMatchObject({ selected: 1 });
  });

  it("on, it asks the owner's line alone; the claim is under the moment's label, whose rule's clearance it is", async () => {
    const { asked, requests } = await extract(true);
    expect(asked).toEqual([evidence]);
    expect(JSON.stringify(requests)).toContain("open a bakery");
    expect(JSON.stringify(requests)).not.toContain("sail around the world");
    const [capture] = await admin<{ compartments: string[] }>(
      "select compartments from knowledge.captures where evidence_id = $1",
      [evidence],
    );
    const rows = await claimRows();
    expect(rows).toHaveLength(1);
    expect([...(rows[0]?.compartments ?? [])].sort()).toEqual([...(capture?.compartments ?? [])].sort());
    expect(capture?.compartments).toContain("agent:desk");
    expect(await savedCalls()).toBe(1);
  });

  it("find_facts serves it as the owner's word with its own mark, and it builds a belief", async () => {
    const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
    const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
    try {
      const answer = await reader.findFacts(deskToken, { type: "goal" });
      if (!answer.ok) throw new Error("refused");
      const facts = (answer.value as FactList).facts;
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        sourceMark: "agent_chat",
        agentReported: false,
        provenance: "source",
        tier: "source",
      });
      // The owner's own page reads the same mark.
      const shown = await owner.facts.show((await claimRows())[0]?.id as never);
      expect(shown?.fact).toMatchObject({ sourceMark: "agent_chat" });
      // The lane's moment counts in the outcome line.
      expect((await yieldLine()).sample).toBe(1);
      expect((await yieldLine()).value).toBe(1);
      // A moment outside the key file's unrestricted compartments counts for nothing. Relabelled as
      // the table's owner: no runtime role updates a label.
      const relabel = (sql: string) => asTablesOwner(db, ["knowledge.captures"], (query) => query(sql, [evidence]));
      await relabel(
        "update knowledge.captures set compartments = array_append(compartments, 'restricted:health') where evidence_id = $1",
      );
      expect((await yieldLine()).sample).toBe(0);
      await relabel(
        "update knowledge.captures set compartments = array_remove(compartments, 'restricted:health') where evidence_id = $1",
      );
      const given = (await pipeline.beliefClaims()).flatMap((group) => group.claims);
      expect(given.filter((one) => one.claim.content.type === "goal")).toEqual([
        expect.objectContaining({ ownerSaid: true }),
      ]);
    } finally {
      await pipeline.close();
      await reader.close();
    }
  });

  it("an erasure takes the claim and the saved call, and a later run brings neither back (invariant 10)", async () => {
    await owner.erasure.eraseItem({ kind: "capture", id: captureId as never }, { requestId: idOf("req") as never });
    expect(await claimRows()).toEqual([]);
    expect(await savedCalls()).toBe(0);
    const { asked } = await extract(true);
    expect(asked).toEqual([]);
    expect(await claimRows()).toEqual([]);
  });
});
