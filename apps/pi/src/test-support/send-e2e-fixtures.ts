import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ErasureJournalEntry, PersonalLogEvent, type PersonalLogger } from "@intelligence/contracts/personal";
import { gmailItemId, repoRoot } from "@intelligence/personal-core";
import type { GmailMessage } from "@intelligence/personal-core/items";
import {
  type FakeGmail,
  FOLD_SETUP,
  fakeSources,
  type World,
  type WorldAccount,
  world,
} from "@intelligence/personal-core/testing";
import {
  appendJournal,
  applyMigrations,
  createPipeline,
  createWriter,
  ensureJournal,
  forSending,
  journalPath,
  narrowKeyFile,
  sealRow,
  type Writer,
} from "@intelligence/personal-store";
import type { WorkClient } from "@intelligence/personal-store/testing";
import {
  type Account,
  asSuperuser,
  batchOf,
  claimRecord,
  copiesOf,
  createTestDatabase,
  dropDatabase,
  fingerprint,
  queryAs,
  type SendCtx,
  suppress,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import pg from "pg";
import { afterAll, expect } from "vitest";
import type { RunDeps } from "../command-types.ts";
import { runSync } from "../intake/sync.ts";
import { collect, pi } from "./run-pi.ts";

// What the send-e2e-*.db.test.ts files share.
//
// The send proxy's gate tests G1 to G14, on the synthetic world. The agent API is the real `pi mcp`
// process, and so is `pi work tick`; the owner's commands run through `run` with the environment
// their wrapper loads, and `pi send` gets the proxy's URL and a key file narrowed as the wrapper
// narrows it, with the erasure journal copied beside it. Sync runs in-process, because the fakes
// live in this process. Google is the fake Gmail of `@intelligence/personal-core/testing`; every
// request any process makes reaches it and is recorded: in-process through `deps.google.fetch`, and
// from a spawned process through a preload that sends every `fetch` to a loopback server here. No
// request reaches Google, and no model is called.

export const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
export const SRC = `${repoRoot()}/`;
export const LONG = 600_000;
export const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
export const READS = ["get_self", "search", "get_entity", "get_timeline", "find_messages", "read_message"];
export const AGENT_WORK = [
  "list_opportunities",
  "claim_opportunity",
  "release_opportunity",
  "propose_hypothesis",
  "record_test",
  "propose_opportunity",
  "plan_move",
  "report_move",
  "set_intention",
];
export const RUN_TOOLS = ["next_run", "append_step", "finish_run"];
const KEY_COMPARTMENTS = ["own", "employer:example", "agent:recorder", "agent:other"];
export const PLAIN = "plain.person@send-e2e.test";
export const IMPORTS_SEND = /(from|import\()\s*["']@intelligence\/personal-google\/send["']/;
export const CANARY = {
  subject: "canary-send-subject-5d2e",
  text: "canary-send-text-5d2e, said once and sent once",
  address: "canary.send.5d2e@send-e2e.test",
} as const;

export type Env = Record<string, string>;
export type Result = { exit: number | null; stdout: string; stderr: string };
export type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; code: string };
export type Reply = {
  jsonrpc: "2.0";
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};
export type Client = WorkClient;

export const log: PersonalLogger = {
  info: (one) => void PersonalLogEvent.parse(one),
  warn: (one) => void PersonalLogEvent.parse(one),
  error: (one) => void PersonalLogEvent.parse(one),
};
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const newId = (prefix: string): string =>
  `${prefix}_${[...randomBytes(26)].map((byte) => CROCKFORD.charAt(byte & 31)).join("")}`;
export const req = (): string => `req-${randomBytes(8).toString("hex")}`;
export const codeOf = (result: { stderr: string }): string | undefined =>
  (/"command_failed","code":"([a-z_]+)"/.exec(result.stderr) ?? [])[1];

// ---------------------------------------------------------------------------------------------
// Every fetch of a spawned process goes to the loopback server, which hands it to the fake
// Gmail of the test that is running. The preload is written into the test's folder.
// ---------------------------------------------------------------------------------------------

// It also folds the synthetic world's documentation domains as this process does.
const PRELOAD = `
import ${JSON.stringify(FOLD_SETUP)};
const target = process.env.E2E_FAKE_GOOGLE;
const real = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof Request ? input.url : String(input);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const body = typeof init.body === "string" ? init.body : init.body == null ? "" : String(init.body);
  const answer = await real(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, method: init.method ?? "GET", headers, body }), signal: init.signal });
  const { status, text } = await answer.json();
  if (status === 0) throw new TypeError("fetch failed");
  return new Response([101, 204, 205, 304].includes(status) ? null : text, { status });
};
`;

let folder = "";
export let preload = "";
let server: Server;
export let loopback = "";
// The fake Gmail every spawned process reaches: the one of the world the running test built.
let active: FakeGmail | null = null;

// Starts the loopback server. Each send-e2e-*.db.test.ts file runs it before its tests.
export async function startLoopback(): Promise<void> {
  folder = await mkdtemp(join(tmpdir(), "pi-send-e2e-"));
  preload = join(folder, "fetch-to-fake.mjs");
  await writeFile(preload, PRELOAD);
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
    request.on("end", async () => {
      const asked = JSON.parse(body) as { url: string; method: string; headers: Record<string, string>; body: string };
      let answer: { status: number; text: string };
      try {
        if (active === null) throw new Error("no world");
        const got = await active.fetch(asked.url, {
          method: asked.method,
          headers: asked.headers,
          ...(asked.body === "" ? {} : { body: asked.body }),
        });
        answer = { status: got.status, text: await got.text() };
      } catch {
        answer = { status: 0, text: "" };
      }
      // The asking process may have been killed while the fake held its answer.
      try {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(answer));
      } catch {
        // Gone.
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  loopback = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/`;
}

export async function stopLoopback(): Promise<void> {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await rm(folder, { recursive: true, force: true });
}

const children: ChildProcess[] = [];

// The real `pi`, with the preload, PATH, the loopback's address and what the step needs.
export function spawnPi(argv: string[], env: Env): ChildProcess {
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, MAIN, ...argv], {
    env: { PATH: process.env.PATH ?? "", E2E_FAKE_GOOGLE: loopback, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function piProcess(argv: string[], env: Env): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawnPi(argv, env);
    let stdout = "";
    let stderr = "";
    child.stdin?.end();
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (exit) => resolve({ exit, stdout, stderr }));
  });
}

// A running `pi mcp`: one message in on its stdin, one reply out on its stdout.
export function mcp(env: Env) {
  const child = spawnPi(["mcp"], env);
  const lines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let buffer = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const next = waiting.shift();
      if (next === undefined) lines.push(line);
      else next(line);
    }
  });
  child.stderr?.resume();
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  void closed.then(() =>
    waiting.splice(0).forEach((next) => {
      next('{"error":{"code":0,"message":"the process ended"}}');
    }),
  );
  let id = 0;
  const call = async (method: string, params?: unknown): Promise<Reply> => {
    id += 1;
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
    );
    const line = lines.shift() ?? (await new Promise<string>((resolve) => waiting.push(resolve)));
    return JSON.parse(line) as Reply;
  };
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<Outcome> => {
    const reply = await call("tools/call", { name, arguments: args });
    if (reply.error !== undefined) return { ok: false, code: reply.error.message };
    const result = reply.result ?? {};
    if (result.isError === true) return { ok: false, code: (result.content as { text: string }[])[0]?.text ?? "" };
    return { ok: true, value: result.structuredContent as Record<string, unknown> };
  };
  return {
    tool,
    async end(): Promise<number | null> {
      child.stdin?.end();
      return closed;
    },
  };
}

export const value = (outcome: Outcome): Record<string, unknown> => {
  if (!outcome.ok) throw new Error(`the call answered ${outcome.code}`);
  return outcome.value;
};

// An owner command through `run`, in this process, with the fake's fetch for Google.
export async function owner(argv: string[], env: Env, deps: RunDeps, tty = false): Promise<Result & { bytes: Buffer }> {
  const out: Buffer[] = [];
  const { exit, stderr } = await pi(argv, env, { tty, deps, stdout: collect(out) });
  const bytes = Buffer.concat(out);
  return { exit, stdout: bytes.toString("utf8"), stderr, bytes };
}

// ---------------------------------------------------------------------------------------------
// One world: a migrated database, the synthetic world synced, the wrapper's copies, and clients.
// ---------------------------------------------------------------------------------------------

export type Box = Awaited<ReturnType<typeof box>>;

// The database every box of a file starts from: the key file and its empty erasure journal (pi work
// tick and pi mcp refuse to start without one: journal_refused), the world synced, the read
// secrets of `personal` and its send secret, as `pi send connect` stores it once the consent is
// made. It is built once, at the file's first box, and each box gets a copy (copiesOf) with fresh
// fakes of the same world, which hold what the synced ones held.
let builtNow = new Date();
const synced = copiesOf(async () => {
  builtNow = new Date();
  const db = await createTestDatabase({ compartments: KEY_COMPARTMENTS });
  try {
    await ensureJournal(journalPath(db.keyFile));
    const writer = createWriter({ url: db.urls.writer, keys: db.keys, log });
    try {
      const result = await runSync({
        writer,
        sources: fakeSources(world({ now: builtNow }), { clock: () => Date.now() }),
        log,
        now: builtNow,
      });
      expect(
        result.outcomes.every((one) => one.outcome === "ok"),
        JSON.stringify(result.outcomes),
      ).toBe(true);
    } finally {
      await writer.close();
    }
    for (const [name, secret] of [
      ["google/personal/client", "{}"],
      ["google/personal/refresh_token", "read-refresh-token"],
    ] as const) {
      await queryAs(db.urls.admin, "insert into policy.secrets (name, value_enc) values ($1, $2)", [
        name,
        sealRow(db.keys, "own", { table: "policy.secrets", id: name, column: "value_enc" }, secret),
      ]);
    }
    const sendSecret = "google-send/personal";
    await queryAs(db.urls.proxy, "insert into policy.secrets (name, value_enc) values ($1, $2)", [
      sendSecret,
      sealRow(
        db.keys,
        "own",
        { table: "policy.secrets", id: sendSecret, column: "value_enc" },
        JSON.stringify({ clientId: "send-client", clientSecret: "send-secret", refreshToken: "send-refresh-token" }),
      ),
    ]);
    return db;
  } catch (error) {
    await db.drop();
    throw error;
  }
});
afterAll(() => synced.drop());

// `contacts`: the labels whose saved contacts the fakes hold; a label's contacts sync once its
// contacts token is stored.
async function box(options: { contacts?: ("personal" | "work")[] } = {}) {
  let db: TestDatabase = await synced.copy();
  const w: World = world({ now: builtNow });
  const found = w.accounts.find((one) => one.label === "personal");
  if (found === undefined) throw new Error("the world has a personal account");
  const personal: WorldAccount = found;
  const sources = fakeSources(w, {
    clock: () => Date.now(),
    ...(options.contacts === undefined ? {} : { contacts: options.contacts }),
  });
  const gmail = sources[0]?.gmail;
  if (gmail === undefined) throw new Error("the world has two accounts");
  active = gmail;
  const keyFile = db.keyFile;
  const sendKeyFile = join(folder, `send-keys-${randomBytes(4).toString("hex")}.json`);
  let writer: Writer = createWriter({ url: db.urls.writer, keys: db.keys, log });
  const deps: RunDeps = {
    google: { fetch: gmail.fetch, sleep: async () => {}, now: () => Date.now(), random: () => 0.5, timeoutMs: 5_000 },
    listenTimeoutMs: 20,
  };

  const admin = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
    queryAs<Row>(db.urls.admin, text, values);
  // As the superuser would: asSuperuser, with a policy on the table an update names.
  const superuser = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
    asSuperuser<Row>(db, /^update ([a-z_]+\.[a-z_]+) /.exec(text)?.[1] ?? null, text, values);
  const adminEnv = (): Env => ({ PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: keyFile });
  const readerEnv = (token: string): Env => ({
    PI_DATABASE_URL_READER: db.urls.reader,
    PI_KEY_FILE: keyFile,
    PI_CLIENT_TOKEN: token,
  });
  const workEnv = (): Env => ({ PI_DATABASE_URL_WORK: db.urls.work, PI_ERASURE_JOURNAL: journalPath(keyFile) });

  // The wrapper's two copies, made at each start: the key file narrowed by name to the fingerprint
  // key, `own` and every `agent:` key, and the whole journal beside it.
  async function wrapper(): Promise<Env> {
    await rm(sendKeyFile, { force: true });
    await narrowKeyFile(keyFile, sendKeyFile, forSending);
    await rm(journalPath(sendKeyFile), { force: true });
    if (
      await stat(journalPath(keyFile)).then(
        () => true,
        () => false,
      )
    )
      await copyFile(journalPath(keyFile), journalPath(sendKeyFile));
    return { PI_DATABASE_URL_PROXY: db.urls.proxy, PI_KEY_FILE: sendKeyFile };
  }

  async function sync(): Promise<void> {
    const result = await runSync({ writer, sources, log, now: new Date() });
    expect(
      result.outcomes.every((one) => one.outcome === "ok"),
      JSON.stringify(result.outcomes),
    ).toBe(true);
  }

  // A client as `pi clients add` stores one, written as pi_admin, with a session opened under
  // its token as pi mcp opens one.
  async function client(
    name: string,
    compartments: string[],
    tools: string[],
    kind: "agent" | "reasoner" = "agent",
  ): Promise<Client> {
    const token = `pit_${randomBytes(32).toString("base64url").slice(0, 43)}`;
    const id = newId("cli");
    await admin(
      `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind)
       values ($1, $2, $3, 'active', 'none', 'local', $4, '{self,people,work}', $5, $6)`,
      [id, name, createHash("sha256").update(token, "utf8").digest("hex"), compartments, tools, kind],
    );
    const session = newId("ses");
    const connection = new pg.Client({ connectionString: db.urls.reader });
    await connection.connect();
    try {
      await connection.query("begin");
      await connection.query("select set_config('pi.client_token', $1, true)", [token]);
      await connection.query("select policy.open_session($1)", [session]);
      await connection.query("commit");
    } finally {
      await connection.end();
    }
    return { id, name, token, compartments, kind, session };
  }

  const [mailAccount] = await admin<{ id: string }>(
    "select id from vault.source_accounts where label = 'personal' and connector = 'google_mail'",
  );
  if (mailAccount === undefined) throw new Error("personal is not connected");

  const sourceFp = (gmailId: string): string => fingerprint(db.keys, "source_id", gmailItemId(gmailId));
  const evidenceOf = async (gmailId: string) =>
    (
      await admin<{ id: string; system_originated: boolean; answers_system: boolean; sent_id: string | null }>(
        "select id, system_originated, answers_system, sent_id from vault.evidence_items where source_item_fp = $1 order by id",
        [sourceFp(gmailId)],
      )
    )[0];
  const messageOf = async (gmailId: string): Promise<string> =>
    (
      await admin<{ id: string }>(
        "select m.id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1",
        [sourceFp(gmailId)],
      )
    )[0]?.id ?? "";

  // A message a reply can answer: an own inbound message of a person, the latest on its thread,
  // with a Message-ID, stored and not held.
  async function answerable(skip: string[] = []): Promise<{ gmail: GmailMessage; message: string; from: string }> {
    const header = (one: GmailMessage, name: string): string =>
      one.headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
    const latest = (one: GmailMessage): boolean =>
      !personal.messages.some((other) => other.threadId === one.threadId && other.internalDate > one.internalDate);
    for (const one of [...personal.messages].sort((a, b) => b.internalDate - a.internalDate)) {
      if (
        skip.includes(one.id) ||
        personal.deleteLater.includes(one.id) ||
        one.labelIds.join(",") !== "INBOX" ||
        header(one, "message-id") === "" ||
        !latest(one)
      )
        continue;
      const from = (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]+/.exec(header(one, "from").toLowerCase()) ?? [])[0];
      if (from === undefined || w.owner.addresses.includes(from)) continue;
      const [row] = await admin<{ id: string }>(
        "select m.id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1 and not m.held and m.direction = 'inbound' and not m.bulk and m.thread_id_enc is not null",
        [sourceFp(one.id)],
      );
      if (row !== undefined) return { gmail: one, message: row.id, from };
    }
    throw new Error("the world has no message a reply can answer");
  }

  // The owner's `show` then `send draft`, with the flags `show` names and the code it prints.
  async function show(
    draft: string,
  ): Promise<Result & { bytes: Buffer; code: string; flags: string[]; reveal: string | null }> {
    const shown = await owner(["send", "show", draft], await wrapper(), deps, true);
    const lines = shown.stdout.split("\n");
    const code = (/^code ([0-9a-f]{8})$/.exec(lines.find((line) => line.startsWith("code ")) ?? "") ?? [])[1] ?? "";
    const flags = (lines.find((line) => line.startsWith("flags ")) ?? "flags none").slice("flags ".length);
    const reveal =
      (/^reveal code ([0-9a-f]{8})$/.exec(lines.find((line) => line.startsWith("reveal code ")) ?? "") ?? [])[1] ??
      null;
    return { ...shown, code, flags: flags === "none" ? [] : flags.split(" "), reveal };
  }
  async function send(draft: string, more: string[] = []): Promise<Result> {
    const shown = await show(draft);
    return owner(["send", "draft", draft, "--code", shown.code, ...shown.flags, ...more], await wrapper(), deps);
  }
  const sendCommand = async (argv: string[]): Promise<Result> => owner(["send", ...argv], await wrapper(), deps);
  const list = async () =>
    JSON.parse((await sendCommand(["list"])).stdout) as {
      drafts: { id: string; status: string; failed: string[] }[];
      sends: { id: string; draft: string; status: string; stale: boolean; copyStored: boolean; copyMissing: boolean }[];
    };
  const sends = (): number => gmail.requests.filter((one) => one.url === SEND_URL).length;
  const tick = async (): Promise<void> => expect((await piProcess(["work", "tick"], workEnv())).exit).toBe(0);
  const sendRow = async (draft: string) =>
    (
      await admin<{ id: string; source_item_fp: string | null; thread_fp: string | null; sent_at: Date | null }>(
        "select id, source_item_fp, thread_fp, sent_at from ledger.sent_messages where draft_id = $1 order by begun_at",
        [draft],
      )
    )[0];
  const latest = async (kind: "draft" | "send" | "card", id: string): Promise<string | null> =>
    (
      await admin<{ event: string }>(
        "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id desc limit 1",
        [kind, id],
      )
    )[0]?.event ?? null;
  const cardOf = async (draft: string): Promise<string | null> =>
    (
      await admin<{ id: string }>(
        "select id from ledger.cards where target_kind = 'draft' and target_id = $1 order by created_at, id",
        [draft],
      )
    )[0]?.id ?? null;
  const account: Account = { id: mailAccount.id, label: "personal", address: personal.address, compartments: ["own"] };
  const ctx = (as: Client): SendCtx => ({
    db,
    admin: (text, values) => admin(text, values ?? []),
    client: as,
    account,
  });

  // A use-only claim of a stored message, as extraction makes one: disclosure third_party, its
  // one text value `text`. Its id.
  async function useOnly(gmailId: string, text: string): Promise<string> {
    const evidence = (await evidenceOf(gmailId))?.id ?? "";
    const [self] = await admin<{ id: string }>("select id from knowledge.entities where kind = 'owner'");
    const record = claimRecord(evidence, "own", self?.id ?? "", { n: 1 });
    const claim = {
      ...record,
      disclosure: ["third_party"],
      claim: { ...record.claim, content: { ...record.claim.content, fields: { what: text } } },
    };
    const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log });
    try {
      await pipeline.commit(batchOf(evidence, [claim as never]));
    } finally {
      await pipeline.close();
    }
    // The store keeps a claim under the fingerprint of the id its record carries.
    return fingerprint(db.keys, "claim", (claim.claim as { id: string }).id);
  }

  // A suppression as an erasure makes one: its rows and its journal entry, so the journal stays
  // level with the database's erasure mark and pi mcp and pi send start.
  async function suppressed(as: SendCtx, fp: string): Promise<void> {
    await suppress(as, fp);
    const [row] = await admin<{ id: string; seq: number }>(
      "select id, journal_seq::int as seq from knowledge.erasures order by journal_seq desc limit 1",
    );
    await appendJournal(journalPath(keyFile), {
      seq: row?.seq ?? 0,
      erasure: row?.id ?? "",
      kind: "person",
      items: [],
      suppress: [fp],
    } as unknown as ErasureJournalEntry);
  }

  // A draft through the real pi mcp, as the client: its id, or the refusal's code.
  async function draft(as: Client, args: Record<string, unknown>): Promise<Outcome> {
    const session = mcp(readerEnv(as.token));
    const outcome = await session.tool("draft_message", { requestId: req(), ...args });
    expect(await session.end()).toBe(0);
    return outcome;
  }
  const drafted = async (as: Client, args: Record<string, unknown>): Promise<string> =>
    value(await draft(as, args)).draft as string;

  return {
    w,
    personal,
    gmail,
    sources,
    deps,
    get db() {
      return db;
    },
    admin,
    superuser,
    adminEnv,
    readerEnv,
    workEnv,
    wrapper,
    sync,
    client,
    sourceFp,
    evidenceOf,
    messageOf,
    answerable,
    show,
    send,
    sendCommand,
    list,
    sends,
    tick,
    sendRow,
    latest,
    cardOf,
    ctx,
    draft,
    drafted,
    account,
    useOnly,
    suppressed,
    // A backup restored (G13): the database copied while nothing is connected, then put back
    // under its own name, so every role URL names the restored copy.
    async backup(): Promise<() => Promise<void>> {
      await writer.close();
      const maintenance = db.urls.bootstrap.replace(new RegExp(`/${db.name}$`), "/postgres");
      const copy = `${db.name}_b`;
      await queryAs(
        maintenance,
        `create database ${pg.escapeIdentifier(copy)} template ${pg.escapeIdentifier(db.name)}`,
      );
      writer = createWriter({ url: db.urls.writer, keys: db.keys, log });
      return async () => {
        await writer.close();
        await dropDatabase(db.name);
        await queryAs(
          maintenance,
          `alter database ${pg.escapeIdentifier(copy)} rename to ${pg.escapeIdentifier(db.name)}`,
        );
        // The database's own privileges, which a template does not carry.
        await applyMigrations(db.urls.bootstrap);
        writer = createWriter({ url: db.urls.writer, keys: db.keys, log });
      };
    },
    async close(): Promise<void> {
      active = null;
      for (const child of children.splice(0)) child.kill("SIGKILL");
      await writer.close();
      await db.drop();
      db = undefined as never;
    },
  };
}

// One world for each test, closed after it.
export async function within(
  fn: (b: Box) => Promise<void>,
  options: { contacts?: ("personal" | "work")[] } = {},
): Promise<void> {
  const b = await box(options);
  try {
    await fn(b);
  } finally {
    await b.close();
  }
}

export const drafter = (b: Box, name = "mine") => b.client(name, ["own"], [...READS, "draft_message"]);
