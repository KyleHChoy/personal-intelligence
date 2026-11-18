import { createHash, randomBytes } from "node:crypto";
import type { ModelRequest, ModelResponse } from "@intelligence/contracts";
import {
  type CaptureItem,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
  type RunSummary,
} from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { type DriveFile, deriveItem, driveItem, type ItemContext } from "@intelligence/personal-core/items";
import { type ExtractDeps, runExtraction } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  googleSecretName,
  journalPath,
  openRow,
} from "@intelligence/personal-store";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  fingerprint,
  queryAs,
  sealRow,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunDeps } from "../command-types.ts";
import { MODEL_ID, quiet } from "../test-support/extract-fixtures.ts";
import { CLIENT, pi } from "../test-support/sync-db-fixtures.ts";

// The moment lane's gate test. Moments are pushed as Lens pushes them, drained by `pi sync` run
// in-process against a fake Google with its clock injected, and the extraction is run as `pi
// extract` runs it, as pi_pipeline, with the fake model answering by evidence id and counting its
// calls. No network, no real model and no wait. One database for the file. Reserved domains only.
//
// The world: a Gmail moment whose account is the connected Google label's address, which the drain
// drops (connected_source); a doc moment of a Google Doc stored under a Drive root of that label;
// and one more chat moment than a day cap of OLD_CAP would allow, each a group of its own. There
// is no cap, so every one is asked; and `pi extract retry --capture` and `--kind` ask again only
// the capture items they name.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const OWNER_ADDRESS = "owner@quinn.test";
const CHAT = { bundle: "test.example.chat", name: "Chat" };
const CHROME = { bundle: "com.google.Chrome", name: "Chrome" };
const FOLDER = "fldPiLensMomentsRoot0001";
const FILE_ID = "docPiLensMomentsStored01";
const TEXT =
  "We went over the kitchen order line by line, the tiles, the paint and the new shelves, and agreed to check the colours again once the samples arrive at the house next week, before anything else is ordered.";

let db: TestDatabase;
let owner: Admin;
const env = (): Record<string, string> => ({ PI_DATABASE_URL_WRITER: db.urls.writer, PI_KEY_FILE: db.keyFile });
const admin = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);
const idOf = (prefix: string): string =>
  `${prefix}_01JPKNSM${randomBytes(9)
    .toString("hex")
    .toUpperCase()
    .replace(/[ILOU]/g, "X")
    .slice(0, 18)}`;

async function addDevice(): Promise<string> {
  const capture = { id: idOf("cli"), token: `pit_test-mac-${randomBytes(8).toString("hex")}` };
  const mirror = idOf("cli");
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  await admin(insert, [
    capture.id,
    "mac-capture",
    sha256Hex(capture.token),
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
    capture.id,
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
  return capture.token;
}

// A scope rule under `own`, by hand as pi_admin; a multi-account host's names its account.
async function insertScope(match: "bundle" | "host", value: string, account?: string): Promise<void> {
  const id = idOf("csr");
  const sealed = (column: string, text: string) =>
    sealRow(db.keys, "own", { table: "policy.capture_scope", id, column }, text);
  await admin(
    "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds) values ($1, $2, $3, $4, $5, $6, 'own', '{moment}')",
    [
      id,
      match,
      fingerprint(db.keys, "capture_scope", value),
      sealed("value_enc", value),
      account === undefined ? null : fingerprint(db.keys, "capture_scope", account),
      account === undefined ? null : sealed("account_enc", account),
    ],
  );
}

let keys = 0;
const moment = (offset: number, over: Partial<MomentItem> = {}): MomentItem => {
  keys += 1;
  return {
    kind: "moment",
    key: `moment:01JPKNSMMNT${String(keys).padStart(15, "0")}`,
    revision: 0,
    observedAt: local(offset),
    endedAt: local(offset),
    app: CHAT,
    entity: "chat",
    thread: `Thread ${keys}`,
    participants: [],
    text: TEXT,
    read: "ax",
    ...over,
  };
};

// The Gmail moment the drain drops; the doc moment, the newest of the world, so the run takes it
// first; and one more chat moment than OLD_CAP, since the lane has no day cap (a run is governed
// by its spend, not a request count), each on a thread of its own, every one settled, each the
// owner's turn, since the lane asks only a chat with turns.
const OLD_CAP = 100;
const GMAIL = moment(-130 * MINUTE, {
  app: CHROME,
  entity: "mail",
  url: "https://mail.google.com/mail/u/0/",
  account: OWNER_ADDRESS,
  thread: "Inbox",
});
const DOC = moment(-125 * MINUTE, {
  app: CHROME,
  entity: "doc",
  url: `https://docs.google.com/document/d/${FILE_ID}/edit`,
  account: OWNER_ADDRESS,
  thread: "Kitchen plans",
  window: "Kitchen plans",
});
const CHATS: MomentItem[] = Array.from({ length: OLD_CAP + 1 }, (_, n) =>
  moment(-3 * HOUR - n * MINUTE, { turns: [{ from: 0, to: TEXT.length, speaker: "owner" }] }),
);

function google(): RunDeps {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = `${url.host}${url.pathname}`;
    if (path === "oauth2.googleapis.com/token")
      return json({
        access_token: "sentinel-access-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope:
          "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly",
      });
    if (path === "gmail.googleapis.com/gmail/v1/users/me/profile")
      return json({ emailAddress: OWNER_ADDRESS, historyId: "1000" });
    if (path === "gmail.googleapis.com/gmail/v1/users/me/messages") return json({ resultSizeEstimate: 0 });
    if (path === "gmail.googleapis.com/gmail/v1/users/me/history") return json({ historyId: "1000" });
    if (path === "www.googleapis.com/calendar/v3/calendars/primary/events")
      return json({ items: [], nextSyncToken: "sync-1" });
    return json({}, 404);
  };
  return { google: { fetch, sleep: async () => {}, now: () => T, random: () => 0.5, timeoutMs: 5000 } };
}

// The Google Doc the doc moment shows, stored under a Drive root of the personal label, as
// `pi sync` stores one, after the drain so that sync reads no Drive.
async function storeDocument(): Promise<void> {
  const rootId = idOf("drt");
  await admin(
    "insert into policy.drive_roots (id, label, kind, root_fp, mode, created_at, root_enc) values ($1, 'personal', 'folder', $2, 'extract', $3, $4)",
    [
      rootId,
      fingerprint(db.keys, "source_id", FOLDER),
      new Date(T).toISOString(),
      sealRow(db.keys, "own", { table: "policy.drive_roots", id: rootId, column: "root_enc" }, FOLDER),
    ],
  );
  const file: DriveFile = {
    id: FILE_ID,
    name: "Kitchen plans",
    mimeType: "application/vnd.google-apps.document",
    createdTime: new Date(T - 48 * HOUR).toISOString() as DriveFile["createdTime"],
    modifiedTime: new Date(T - 24 * HOUR).toISOString() as DriveFile["modifiedTime"],
    parent: FOLDER,
    root: FOLDER,
    ownedByMe: true,
    modifiedByMe: true,
    owner: { address: OWNER_ADDRESS },
    canDownload: true,
  };
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet, journal: journalPath(db.keyFile) });
  try {
    const account = await writer.ensureSourceAccount("personal", "google_docs", "own", OWNER_ADDRESS);
    const raw = driveItem(file, { blocks: [{ kind: "paragraph", text: "The tiles are ordered for Friday." }] }, null, {
      sourceAccount: account.id,
      changeKind: "backfill",
      ownerAddress: OWNER_ADDRESS,
    });
    expect(await writer.ingestItem(account, raw, (ctx: ItemContext) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe(
      "stored",
    );
  } finally {
    await writer.close();
  }
}

const evidenceOf = async (item: CaptureItem): Promise<string | undefined> =>
  (
    await admin<{ evidence_id: string }>("select evidence_id from knowledge.captures where capture_key = $1", [
      item.key,
    ])
  )[0]?.evidence_id;

// The extraction, as `pi extract` runs it, with the fake model recording the evidence ids asked.
async function extract(options: {
  moments: boolean;
  outputs: Record<string, unknown>;
  documents?: true;
}): Promise<{ asked: string[]; requests: ModelRequest[]; summary: RunSummary }> {
  const asked: string[] = [];
  const requests: ModelRequest[] = [];
  const fake = fakeModelClient(options.outputs, asked);
  const model: ExtractDeps["model"] = {
    complete: (request: ModelRequest): Promise<ModelResponse> => {
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
      compartments: ["own", "employer:example"],
      ...(options.moments ? { moments: true as const, momentsContinuous: true as const } : {}),
      ...(options.documents === true ? { documents: { days: 90 } } : {}),
    });
    if (summary === "already_running") throw new Error("locked");
    return { asked, requests, summary };
  } finally {
    await pipeline.close();
  }
}

async function statusOf(evidenceId: string): Promise<{ status: string; code?: string; lane: string } | undefined> {
  const [row] = await admin<{ facts_enc: unknown; compartments: string[] }>(
    "select facts_enc, compartments from vault.pipeline_items where evidence_id = $1",
    [evidenceId],
  );
  return row === undefined
    ? undefined
    : JSON.parse(
        openRow(
          db.keys,
          row.compartments[0] ?? "own",
          { table: "vault.pipeline_items", id: evidenceId, column: "facts_enc" },
          row.facts_enc as never,
        ),
      );
}

let doc: string;
let chats: string[];
// Every moment's answer: no claim. A request for the doc moment would be recorded all the same.
const outputs = (): Record<string, unknown> =>
  Object.fromEntries([doc, ...chats].map((id) => [id, { claims: [], narrowing: "none" }]));

beforeAll(async () => {
  db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  owner = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
  const token = await addDevice();
  await insertScope("bundle", CHAT.bundle);
  await insertScope("host", "docs.google.com", OWNER_ADDRESS);
  await insertScope("host", "mail.google.com", OWNER_ADDRESS);
  await owner.secrets.setSecret(googleSecretName("personal", "client"), CLIENT);
  await owner.secrets.setSecret(googleSecretName("personal", "refresh_token"), "sentinel-refresh-token-7f3a91");
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
  try {
    const items: CaptureItem[] = [GMAIL, DOC, ...CHATS];
    for (let at = 0, n = 1; at < items.length; at += 50, n += 1) {
      const batch = items.slice(at, at + 50);
      const answer = await reader.pushCapture(token, { batch: `pi-lens-moments-000${n}`, items: batch });
      expect(answer).toEqual({
        ok: true,
        value: { items: batch.map((item) => ({ key: item.key, outcome: "accepted" })) },
      });
    }
  } finally {
    await reader.close();
  }
  // The drain runs after the Gmail sync, so the label is connected when the Gmail moment is read.
  const result = await pi(["sync"], env(), google());
  expect(result.exit, result.stderr).toBe(0);
  await storeDocument();
  doc = (await evidenceOf(DOC)) ?? "";
  chats = [];
  for (const item of CHATS) chats.push((await evidenceOf(item)) ?? "");
  expect(doc).not.toBe("");
  expect(chats.every((id) => id !== "")).toBe(true);
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await owner?.close();
  await db?.drop();
});

describe("the moment lane, end to end (L16, moment half)", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the Gmail moment is dropped at the drain, connected_source, and stores nothing", async () => {
    expect(await evidenceOf(GMAIL)).toBeUndefined();
    const [row] = await admin<{ refused_code: string | null }>(
      "select refused_code from ledger.capture_inbox where source_key_fp = $1",
      [fingerprint(db.keys, "source_id", GMAIL.key)],
    );
    expect(row?.refused_code).toBe("connected_source");
  });

  it("with PI_EXTRACT_MOMENTS unset no moment causes a model call: each is committed not_extracted, the stored Google Doc's too", async () => {
    const { asked } = await extract({ moments: false, outputs: outputs() });
    const moments = new Set([doc, ...chats]);
    expect(asked.filter((id) => moments.has(id))).toEqual([]);
    for (const id of [doc, ...chats])
      expect(await statusOf(id)).toMatchObject({ status: "skipped", code: "not_extracted", lane: "moment" });
  });

  it("with PI_EXTRACT_MOMENTS set, a Gmail moment and a stored Google Doc moment cause no call, and every chat moment is asked, more groups than the old cap, within the dollar lines", async () => {
    const { asked, requests, summary } = await extract({ moments: true, outputs: outputs() });
    const moments = new Set([doc, ...chats]);
    const momentCalls = asked.filter((id) => moments.has(id));
    // The doc moment is never sent; the Gmail moment has no evidence to send.
    expect(momentCalls).not.toContain(doc);
    expect(await statusOf(doc)).toMatchObject({ status: "skipped", code: "connected_source" });
    // No day cap: every chat moment, one more than OLD_CAP, is one request, each one group, the
    // version a run asks, and the run ends ok.
    expect(momentCalls.sort()).toEqual([...chats].sort());
    expect(
      requests
        .filter((request) => request.promptId === "personal_moment")
        .map((request) => request.callKey?.promptVersion),
    ).toEqual(chats.map(() => "9"));
    expect(summary.code).toBe("ok");
    const statuses = await Promise.all(chats.map(statusOf));
    expect(statuses.map((one) => one?.status)).toEqual(chats.map(() => "done"));
    // Every request held one group's moments, under its own call key. The slot: participants by
    // label and at most a name, never an address; each moment its kind, when it was seen and its
    // passages, each with its span, speaker and text alone.
    for (const request of requests.filter((one) => one.promptId === "personal_moment")) {
      const data = JSON.parse(request.data.moments ?? "{}") as {
        participants: Record<string, unknown>[];
        moments: { passages: Record<string, unknown>[] }[];
      };
      expect(data.moments).toHaveLength(1);
      expect(Object.keys(data.moments[0] ?? {}).sort()).toEqual(["kind", "passages", "seen"]);
      for (const passage of data.moments[0]?.passages ?? [])
        expect(Object.keys(passage).sort()).toEqual(["span", "speaker", "text"]);
      for (const participant of data.participants) {
        expect(Object.keys(participant).every((key) => key === "label" || key === "name")).toBe(true);
        expect(JSON.stringify(participant)).not.toContain("@");
      }
    }
  });

  // `pi extract` itself, on a fake Anthropic API, with the moment lane's own model. `pi extract
  // retry --capture` sets the last chat moment, by its capture key, waiting with its saved call
  // superseded, so it is the run's one moment request; no other item is due. The cases above noted
  // their groups under the fixture's model id, route personal_moment, so only the exposure notes
  // this run wrote are read.
  it("with PI_EXTRACT_MOMENT_MODEL set, pi extract asks the moment group of that model at its effort, and its usage row and exposure notes name it", async () => {
    const SONNET = "anthropic/claude-sonnet-5-5";
    const last = CHATS.at(-1) as MomentItem;
    const lastId = chats.at(-1) as string;
    const adminEnv = { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile };
    // A key no stored meeting or moment has is not_found, and changes nothing.
    const missing = await pi(["extract", "retry", "--capture", `moment:01JPKNSMMNT${"9".repeat(15)}`], adminEnv);
    expect(missing.exit).toBe(1);
    const calls = await admin<{ n: number }>(
      "select count(*)::int as n from vault.model_calls where prompt_id = 'personal_moment' and superseded_at is null",
    );
    expect(calls[0]?.n).toBe(chats.length);
    expect(await pi(["extract", "retry", "--capture", last.key], adminEnv)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ selected: 1 })}\n`,
      stderr: "",
    });
    expect(await statusOf(lastId)).toMatchObject({ status: "waiting", lane: "moment" });
    expect(
      (
        await admin<{ evidence_id: string }>(
          "select evidence_id from vault.model_calls where prompt_id = 'personal_moment' and superseded_at is null",
        )
      )
        .map((row) => row.evidence_id)
        .sort(),
    ).toEqual(chats.slice(0, -1).sort());
    const [mark] = await admin<{ before: string }>("select coalesce(max(id), 0)::text as before from ledger.exposures");
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const modelFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const answer = {
        type: "message",
        content: [{ type: "text", text: JSON.stringify({ claims: [], narrowing: "none" }) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof globalThis.fetch;
    const result = await pi(
      ["extract"],
      {
        PI_DATABASE_URL_PIPELINE: db.urls.pipeline,
        PI_KEY_FILE: db.keyFile,
        PI_EXTRACT_ANTHROPIC_KEY: "sk-ant-test-not-a-real-key-0000",
        PI_EXTRACT_MODEL: "anthropic/claude-haiku-5-5",
        PI_EXTRACT_EFFORT: "low",
        PI_EXTRACT_MOMENT_MODEL: SONNET,
        PI_EXTRACT_MOMENT_EFFORT: "medium",
        PI_EXTRACT_MOMENTS: "1",
        PI_EXTRACT_MOMENTS_MODE: "continuous",
      },
      { modelFetch, now: () => new Date(T) },
    );
    expect(result.exit, result.stderr).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(urls.every((url) => url === "https://api.anthropic.com/v1/messages")).toBe(true);
    for (const body of bodies)
      expect(body).toMatchObject({ model: "claude-sonnet-5-5", output_config: { effort: "medium" } });
    // The usage row names the id the client called, in Anthropic's form, never a model string
    // from the answer.
    const used = await admin<{ prompt_id: string; model_id: string; cost_microusd: string }>(
      "select prompt_id, model_id, cost_microusd::text from vault.model_usage",
    );
    expect(used.length).toBe(bodies.length);
    expect(
      used.every(
        (row) =>
          row.prompt_id === "personal_moment" && row.model_id === "claude-sonnet-5-5" && row.cost_microusd === "70",
      ),
    ).toBe(true);
    // Every note this run wrote, under any route and for any recipient: the one group's moment, for the moment model.
    const exposed = await admin<{ recipient: string; route: string; refs: number }>(
      "select recipient, route, count(distinct ref)::int as refs from ledger.exposures where id > $1 group by recipient, route",
      [mark?.before ?? "0"],
    );
    expect(exposed).toEqual([{ recipient: SONNET, route: "personal_moment", refs: 1 }]);
    expect(await statusOf(lastId)).toMatchObject({ status: "done" });
  });

  // A retry of one kind of capture item deletes that kind's saved
  // calls alone: the stored document's stays, with its status row, and only the moments asked
  // again.
  it("retry --kind moment --status done supersedes only the done moments' saved calls and leaves the document's; the next run asks the moments alone", async () => {
    const [document] = await admin<{ evidence_id: string }>("select evidence_id from knowledge.documents");
    const documentId = document?.evidence_id ?? "";
    expect(documentId).not.toBe("");
    // The stored document, extracted once, so it has a saved call and a status row of its own.
    const documented = await extract({
      moments: true,
      outputs: { ...outputs(), [documentId]: { claims: [], narrowing: "none" } },
      documents: true,
    });
    expect(documented.asked).toContain(documentId);
    const documentCalls = await admin<{ id: string; superseded_at: Date | null }>(
      "select id, superseded_at from vault.model_calls where evidence_id = $1",
      [documentId],
    );
    expect(documentCalls.length).toBeGreaterThan(0);
    expect(documentCalls.filter((call) => call.superseded_at !== null)).toEqual([]);
    const documentStatus = await statusOf(documentId);
    expect(documentStatus).toMatchObject({ status: "done" });
    const claimsBefore = await admin<{ id: string }>(
      "select id from knowledge.claims where evidence_id <> all ($1) order by id",
      [chats],
    );

    const adminEnv = { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile };
    // Over fifty items it asks for --yes and changes nothing.
    expect((await pi(["extract", "retry", "--kind", "moment", "--status", "done"], adminEnv)).exit).toBe(1);
    expect(
      (
        await admin<{ n: number }>(
          "select count(*)::int as n from vault.model_calls where prompt_id = 'personal_moment' and superseded_at is null",
        )
      )[0]?.n,
    ).toBe(chats.length);
    expect(await pi(["extract", "retry", "--kind", "moment", "--status", "done", "--yes"], adminEnv)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ selected: chats.length })}\n`,
      stderr: "",
    });
    expect(
      (
        await admin<{ n: number }>(
          "select count(*)::int as n from vault.model_calls where prompt_id = 'personal_moment' and superseded_at is null",
        )
      )[0]?.n,
    ).toBe(0);
    expect(
      await admin<{ id: string; superseded_at: Date | null }>(
        "select id, superseded_at from vault.model_calls where evidence_id = $1",
        [documentId],
      ),
    ).toEqual(documentCalls);
    expect(await statusOf(documentId)).toEqual(documentStatus);
    // The moment the drain marked connected_source was not done, so it was not selected.
    expect(await statusOf(doc)).toMatchObject({ status: "skipped", code: "connected_source" });

    const again = await extract({
      moments: true,
      outputs: { ...outputs(), [documentId]: { claims: [], narrowing: "none" } },
      documents: true,
    });
    expect(again.asked.sort()).toEqual([...chats].sort());
    // No claim of another item changed id.
    expect(
      await admin<{ id: string }>("select id from knowledge.claims where evidence_id <> all ($1) order by id", [chats]),
    ).toEqual(claimsBefore);
  });
});
