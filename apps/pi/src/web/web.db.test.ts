import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CardId, Digest, type NewCard } from "@intelligence/contracts/personal";
import { Admin, newId } from "@intelligence/personal-store";
import { createTestDatabase, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pi, quiet } from "../test-support/extract-fixtures.ts";
import { startWeb, type Web } from "./web.ts";
import { loadClient } from "./web-client.ts";
import { READS } from "./web-routes.ts";

// The dashboard's server on the real Admin, and `pi digest` through `run`.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ORIGIN = "http://localhost:8765";

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function ask(
  socket: string,
  path: string,
  options: { host?: string; cookie?: string; token?: string; json?: unknown } = {},
): Promise<Answer> {
  const body = options.json === undefined ? undefined : JSON.stringify(options.json);
  const headers: Record<string, string> = { host: options.host ?? "localhost:8765" };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.token !== undefined) headers["x-pi-token"] = options.token;
  if (body !== undefined) Object.assign(headers, { origin: ORIGIN, "content-type": "application/json" });
  return new Promise((resolve, reject) => {
    const sent = request(
      { socketPath: socket, path, method: body === undefined ? "GET" : "POST", headers, setHost: false },
      (response) => {
        let text = "";
        response.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
      },
    );
    sent.on("error", reject);
    sent.end(body);
  });
}

const notice = (): NewCard => ({
  id: newId("crd") as CardId,
  requestId: `req-${randomBytes(8).toString("hex")}`,
  kind: "notice",
  author: "system:test",
  options: ["acknowledge"],
  target: null,
  refs: [],
  compartments: ["own"],
  expiresAt: null,
  expiresAfterDays: null,
  caseKey: null,
  run: null,
  body: null,
  bodyFrom: null,
});

// A pool whose connections are counted: the Admin sends every statement on a connection it
// takes with connect(), so no connection is no statement.
function countingPool(pool: pg.Pool): { pool: pg.Pool; connections: () => number } {
  let n = 0;
  const wrapped = new Proxy(pool, {
    get: (target, property) => {
      if (property === "connect") {
        return () => {
          n += 1;
          return target.connect();
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { pool: wrapped, connections: () => n };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const one of cleanup.splice(0).reverse()) await one();
});

type Served = { db: TestDatabase; web: Web; socket: string; connections: () => number; admin: Admin };

async function served(): Promise<Served> {
  const db = await createTestDatabase();
  cleanup.push(() => db.drop());
  const folder = await mkdtemp(join(tmpdir(), "pi-web-db-"));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const raw = new pg.Pool({ connectionString: db.urls.admin, max: 2 });
  cleanup.push(() => raw.end());
  const counted = countingPool(raw);
  const admin = new Admin({ pool: counted.pool, keys: db.keys, log: quiet });
  const socket = join(folder, "keys.json.web");
  const web = await startWeb({ socket, admin, log: quiet, client: await loadClient(join(folder, "no-client")) });
  cleanup.push(() => web.close());
  return { db, web, socket, connections: counted.connections, admin };
}

// A code from the control socket, its login, and the session's token.
async function login(s: Served): Promise<{ cookie: string; token: string }> {
  const code = await new Promise<string>((resolve, reject) => {
    let text = "";
    const connection = createConnection({ path: `${s.socket}-control` });
    connection.setEncoding("utf8");
    connection.on("connect", () => connection.write("link\n"));
    connection.on("data", (chunk: string) => (text += chunk));
    connection.on("end", () => resolve(text.trim()));
    connection.on("error", reject);
  });
  const answer = await ask(s.socket, `/login?code=${code}`);
  expect(answer.status).toBe(303);
  const cookie = ([answer.headers["set-cookie"] ?? []].flat()[0] ?? "").split(";")[0] ?? "";
  const session = await ask(s.socket, "/api/session", { cookie });
  return { cookie, token: (JSON.parse(session.body) as { token: string }).token };
}

// Every column of the owner's decisions but the ones that differ by nature between two cards.
const decisionRows = (db: TestDatabase) =>
  queryAs<Record<string, unknown>>(
    db.urls.admin,
    "select kind, target_kind, target_id, answer, supersedes, batch, labels, details, compartments, body_enc from knowledge.owner_decisions order by card_id",
  );

describe("A2: pi web on the store", () => {
  it("a decision on the page writes the row pi decide writes, with batch false, once", async () => {
    const s = await served();
    const onPage = await s.admin.cards.raiseCard(notice());
    const byCommand = await s.admin.cards.raiseCard(notice());
    const { cookie, token } = await login(s);
    const body = {
      card: onPage.id,
      answer: "acknowledge",
      labels: ["correct"],
      requestId: `req-${randomBytes(8).toString("hex")}`,
    };
    const decided = await ask(s.socket, "/api/decide", { cookie, token, json: body });
    expect(decided.status, decided.body).toBe(200);
    const command = await pi(["decide", byCommand.id, "--answer", "acknowledge", "--labels", "correct"], {
      PI_DATABASE_URL_ADMIN: s.db.urls.admin,
      PI_KEY_FILE: s.db.keyFile,
    });
    expect(command.exit, command.stderr).toBe(0);

    const [first, second] = await decisionRows(s.db);
    expect(first).toMatchObject({ kind: "answer", answer: "acknowledge", batch: false, labels: ["correct"] });
    expect(first).toEqual(second);
    // Decided once: a new request is the Admin's refusal by its code.
    const again = await ask(s.socket, "/api/decide", {
      cookie,
      token,
      json: { ...body, requestId: `req-${randomBytes(8).toString("hex")}` },
    });
    expect(again).toMatchObject({ status: 409, body: '{"refused":"not_pending"}' });
    expect(await decisionRows(s.db)).toHaveLength(2);
  });

  it("a foreign Host is 421 and reads nothing", async () => {
    const s = await served();
    const card = await s.admin.cards.raiseCard(notice());
    const { cookie } = await login(s);
    const before = s.connections();
    for (const path of ["/api/pendingCards", `/api/card?card=${card.id}`])
      expect((await ask(s.socket, path, { host: "evil.example", cookie })).status).toBe(421);
    expect(s.connections()).toBe(before);
    // The positive control: the same requests from localhost read the store.
    for (const path of ["/api/pendingCards", `/api/card?card=${card.id}`])
      expect((await ask(s.socket, path, { cookie })).status).toBe(200);
    expect(s.connections()).toBeGreaterThan(before);
  });

  it("widened: every read of the registry answers the real Admin's result in the registry's shape", async () => {
    const s = await served();
    const card = await s.admin.cards.raiseCard(notice());
    // One of the owner's lists, so `lists` answers a row in its shape.
    const list = await s.admin.lists.createList("Board", { requestId: `req-${randomBytes(8).toString("hex")}` });
    const { cookie } = await login(s);
    const query: Record<keyof typeof READS, string> = {
      pendingCards: "?limit=10",
      card: `?card=${card.id}`,
      agentActivity: "",
      cardsWithLines: "?limit=10",
      results: "?limit=10",
      openResult: `?move=${newId("mov")}`,
      digest: "",
      entityPage: `?entity=${newId("ent")}`,
      factShow: `?fact=${"a".repeat(64)}`,
      listIgnore: "",
      listVetoes: "",
      exposureStatus: "",
      person: `?entity=${newId("ent")}`,
      timeline: `?entity=${newId("ent")}&limit=5`,
      paths: `?target=${newId("ent")}`,
      network: "?tiers=inner,close",
      networkExpand: `?node=${newId("ent")}`,
      goals: "?stale=true",
      goalWork: `?goal=${newId("gol")}`,
      weekEvents: "?from=2026-10-26&to=2026-11-01",
      timeWeek: "?weekStart=2026-10-26",
      spendToday: "",
      budget: "",
      lessons: "",
      confirmRates: "",
      // As the Today room asks it.
      commitments: "?state=open&limit=200",
      openItems: "",
      ledgerDay: "?day=2026-09-15",
      ledgerLanes: "?day=2026-09-15",
      ledgerFeed: "?limit=10",
      spendSeries: "?days=7",
      cardLoadSeries: "?days=7",
      // As the Self room and Today ask them.
      beliefsAsOf: `?subject=${newId("ent")}&at=2026-01-01T00:00:00.000Z`,
      learnedSince: "?at=2026-01-01T00:00:00.000Z",
      // The reads that existed before the dashboard, as the rooms call them.
      timeDay: "?day=2026-10-28",
      timeProposals: "",
      peopleTiers: "?tier=close&dormant=false&limit=10",
      personWarmth: `?entity=${newId("ent")}`,
      lists: "",
      notes: `?person=${newId("ent")}`,
      showWork: `?work=${newId("opp")}`,
      listClients: "",
      releaseGrants: "",
      listSourceAccounts: "",
      status: "",
      coverage: "?days=7",
      listFactRulings: "",
      workStatus: "",
      // As the Self room asks it.
      selfReview: "?limit=200",
      selfActivity: "?limit=50",
      message: `?message=${newId("msg")}`,
      draft: `?draft=${newId("drf")}`,
      meeting: `?meeting=${newId("evt")}`,
      // The System room's: the stored measures and the open defects.
      system: "",
      defects: "",
      // The Projects room's, and Work's read of who is on what.
      projects: "",
      longWork: "",
      // The answers agents passed on, with their quotes.
      relayedAnswers: "",
      // The week's sample of what agents settled.
      agentSettlements: "",
      // The System room's agents, each with its own record.
      agentRecords: "",
      // The Work room's idea ledger.
      ideas: "",
      agentTime: "",
      // The week's sample of what dreaming found.
      dreamSample: "",
    };
    for (const [name, args] of Object.entries(query)) {
      const answer = await ask(s.socket, `/api/${name}${args}`, { cookie });
      if (
        name === "entityPage" ||
        name === "factShow" ||
        name === "person" ||
        name === "timeline" ||
        name === "paths" ||
        name === "showWork" ||
        name === "openResult" ||
        name === "message" ||
        name === "draft" ||
        name === "meeting"
      ) {
        expect(answer, name).toMatchObject({ status: 404, body: '{"refused":"not_found"}' });
        continue;
      }
      // The graph stands on the owner's warmth build, which this store never ran.
      if (name === "network" || name === "networkExpand") {
        expect(answer, name).toMatchObject({ status: 409, body: '{"refused":"rebuilding"}' });
        continue;
      }
      // No belief is built in this store: the owner's audience is being rebuilt.
      if (name === "commitments" || name === "openItems" || name === "beliefsAsOf" || name === "learnedSince") {
        expect(answer, name).toMatchObject({ status: 409, body: '{"refused":"rebuilding"}' });
        continue;
      }
      expect(answer.status, `${name}: ${answer.body}`).toBe(200);
      expect(READS[name as keyof typeof READS].result.safeParse(JSON.parse(answer.body)).success, name).toBe(true);
      if (name === "lists")
        expect(JSON.parse(answer.body)).toEqual([expect.objectContaining({ id: list, name: "Board", members: [] })]);
    }
  });

  it("Settings: the registered agents list answers every kind of client in its shape, and never a token or its hash", async () => {
    const s = await served();
    const agent = await s.admin.clients.addClient({
      name: "test-agent",
      runtime: "cloud",
      vendorRetention: "limited",
      compartments: ["own"],
      views: ["self", "people", "work"],
      tools: ["search", "get_self"],
    });
    await s.admin.work.setClientRoles("test-agent", ["researcher"]);
    await s.admin.clients.setWebhook("test-agent", "https://agent.example.test/notice");
    const reasoner = await s.admin.clients.addClient({
      name: "test-reasoner",
      kind: "reasoner",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: ["self"],
      tools: ["search"],
    });
    await s.admin.clients.addClient({
      name: "test-gone",
      runtime: "local",
      vendorRetention: "unknown",
      compartments: ["own"],
      views: ["self"],
      tools: ["get_self"],
    });
    await s.admin.clients.revokeClient("test-gone");
    const device = await s.admin.lens.addDevice("test-mac", { compartments: ["own"], views: ["self"] });
    const { cookie } = await login(s);
    const answer = await ask(s.socket, "/api/listClients", { cookie });
    expect(answer.status, answer.body).toBe(200);
    const rows = READS.listClients.result.parse(JSON.parse(answer.body));
    expect(rows.map((row) => [row.name, row.kind, row.status])).toEqual([
      ["test-agent", "agent", "active"],
      ["test-gone", "agent", "revoked"],
      ["test-mac", "agent", "active"],
      ["test-mac-capture", "device", "active"],
      ["test-reasoner", "reasoner", "active"],
    ]);
    expect(rows[0]).toMatchObject({ roles: ["researcher"], webhook: true });
    const hashes = await queryAs<{ token_hash: string }>(s.db.urls.admin, "select token_hash from policy.clients");
    for (const secret of [
      agent.token,
      reasoner.token,
      device.capture,
      ...hashes.map((row) => row.token_hash),
      "agent.example.test",
    ])
      expect(answer.body).not.toContain(secret);
  });

  it("pi digest prints the counts as one JSON document", async () => {
    const s = await served();
    await s.admin.cards.raiseCard(notice());
    const result = await pi(["digest"], { PI_DATABASE_URL_ADMIN: s.db.urls.admin, PI_KEY_FILE: s.db.keyFile });
    expect(result.exit, result.stderr).toBe(0);
    expect(Digest.parse(JSON.parse(result.stdout))).toEqual({
      pending: { notice: 1 },
      deferred: 0,
      oldestPendingDays: 0,
      heldMessages: 0,
      withheldItems: 0,
    });
    expect(result.stdout.endsWith("}\n")).toBe(true);
  });
});
