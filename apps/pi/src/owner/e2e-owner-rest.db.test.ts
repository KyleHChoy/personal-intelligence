import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CardId,
  ClientView,
  CommitmentList,
  FactView,
  NewCard,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import { FOLD_SETUP, fakeSources, world, worldModelOutputs } from "@intelligence/personal-core/testing";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { createAdmin, createReader, createWriter, loadKeys, newId } from "@intelligence/personal-store";
import { createTestDatabase, queryAs, scanForPlaintext, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runSync } from "../intake/sync.ts";
import {
  type Env,
  gmailAccounts,
  gmailIds,
  pi as inProcess,
  MODEL_ID,
  quiet,
  SENTINEL_KEY,
  withAdmin,
} from "../test-support/extract-fixtures.ts";
import { mcpAtOnce } from "../test-support/mcp-fixtures.ts";

// The rest of the owner surface end to end: gate tests U1 to U6. The synthetic world, with its `employer:example`
// account, is synced into a database made for this file, and three clients are registered through the real `pi`:
// one cleared for `own`, one for `own` and `declassified`, one for `employer:example`. Every owner command, every
// agent API call and the web page run in the real `pi` process; sync and extraction run in-process on the fakes,
// as the other end-to-end tests run them, since the fakes live in this process. Each gate test runs twice: before,
// and after, a full `pi sync --reset gmail` (`runSync` with `reset: ["gmail"]`).

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
const TOOLS = "get_self,find_facts,get_commitments";
const MARKUP = `<b onclick="x()">canary-web-markup</b><script>alert(1)</script>&'`;
// Names an agent might try for this item's commands, and the real tools' names given them anyway.
const OWNER_ONLY = [
  "correct_reject",
  "correct_veto",
  "correct_lift",
  "facts_show",
  "declassify",
  "declassify_add",
  "declassify_revoke",
  "digest",
  "web",
  "decide",
  "review",
  "show",
];

type Result = { exit: number | null; stdout: string; stderr: string };

// The real process, with an explicit environment.
function pi(argv: string[], env: Env, stdin = ""): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", FOLD_SETUP, MAIN, ...argv], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (exit) => resolve({ exit, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

const ok = async (argv: string[], env: Env, stdin?: string): Promise<string> => {
  const result = await pi(argv, env, stdin);
  expect(result.exit, `pi ${argv.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout;
};

type Reply = {
  result?: { isError?: boolean; structuredContent?: unknown; content?: { text: string }[]; tools?: { name: string }[] };
  error?: { message: string };
};

// One agent API process for a list of requests: each reply. The stand-in for pi mcp that waits
// no reply deadline (mcp-fixtures.ts): these tests compare what is answered, not when.
async function mcp(env: Env, token: string, requests: { method: string; params?: unknown }[]): Promise<Reply[]> {
  const lines = requests.map((one, n) => JSON.stringify({ jsonrpc: "2.0", id: n + 1, ...one })).join("\n");
  const result = await mcpAtOnce({ ...env, PI_CLIENT_TOKEN: token }, `${lines}\n`);
  expect(result.exit, result.stderr).toBe(0);
  return result.stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Reply);
}

// A tool's structured answer, or its refusal's code.
const outcome = (reply: Reply | undefined): unknown => {
  if (reply?.error !== undefined) return { error: reply.error.message };
  return reply?.result?.isError === true
    ? { error: reply.result.content?.[0]?.text }
    : reply?.result?.structuredContent;
};
const call = async (env: Env, token: string, name: string, args: Record<string, unknown> = {}): Promise<unknown> =>
  outcome((await mcp(env, token, [{ method: "tools/call", params: { name, arguments: args } }]))[0]);

// find_facts over MCP answers in the wire form, which leaves out a false thirdParty and a null
// message: each fact read back with them, as its strict form has them.
const facts = async (env: Env, token: string, args: Record<string, unknown> = {}): Promise<FactView[]> =>
  ((await call(env, token, "find_facts", { limit: 50, ...args })) as { facts: FactView[] }).facts.map(
    (one) => ({ ...one, thirdParty: one.thirdParty ?? false, message: one.message ?? null }) as FactView,
  );

// One request to the page's socket.
type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
function ask(
  socket: string,
  path: string,
  options: { host?: string; cookie?: string; origin?: string; token?: string; json?: unknown } = {},
): Promise<Answer> {
  const body = options.json === undefined ? undefined : JSON.stringify(options.json);
  const headers: Record<string, string> = { host: options.host ?? "localhost:8765" };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.token !== undefined) headers["x-pi-token"] = options.token;
  if (body !== undefined) headers["content-type"] = "application/json";
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

// `pi web serve` runs with no terminal, as the box's supervisor starts it. `pi web link` needs a
// terminal for its stdout: it runs under `script`, which gives it a pseudo-terminal on macOS and on
// Linux. `script`'s own stdin is /dev/null: macOS's refuses a socket there. Without `script`, U5
// is skipped with that reason.
const HAS_SCRIPT =
  spawnSync("script", ["-q", "/dev/null", "true"], { stdio: "ignore", timeout: 10_000 }).error === undefined;
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

type Served = { child: ChildProcess; link(): Promise<string>; stop(): Promise<void> };

// Until `ready` holds, or ten seconds.
async function until(ready: () => boolean): Promise<void> {
  for (let n = 0; n < 200 && !ready(); n += 1) await new Promise((resolve) => setTimeout(resolve, 50));
}

// `pi web link` in a terminal: the link it printed.
async function webLink(env: Env): Promise<string> {
  const [command, args] =
    process.platform === "darwin"
      ? ["script", ["-q", "/dev/null", process.execPath, MAIN, "web", "link"]]
      : ["script", ["-qfec", `${quote(process.execPath)} ${quote(MAIN)} web link`, "/dev/null"]];
  const child = spawn(command as string, args as string[], {
    env: { PATH: process.env.PATH ?? "", SHELL: "/bin/sh", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  const found = output.match(/http:\/\/localhost:\d+\/login\?code=[A-Za-z0-9_-]{43}/)?.[0];
  if (found === undefined) throw new Error(`pi web link printed no link: ${output}`);
  return found;
}

async function servedWeb(env: Env, socket: string): Promise<Served> {
  const child = spawn(process.execPath, [MAIN, "web", "serve"], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  // The control socket is made after the page's.
  await until(() => existsSync(`${socket}-control`));
  if (!existsSync(`${socket}-control`)) throw new Error(`pi web serve did not start: ${output}`);
  return {
    child,
    link: () => webLink(env),
    // `pi web stop`, then the server's own end, which removes both sockets.
    stop: async () => {
      await ok(["web", "stop"], env);
      await closed;
      await until(() => !existsSync(socket));
    },
  };
}

const requestId = (): string => `req-${randomBytes(8).toString("hex")}`;
const notice = (body: string | null): NewCard => ({
  id: newId("crd") as CardId,
  requestId: requestId(),
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
  body,
  bodyFrom: body === null ? null : "model",
});

describe("corrections-and-digest, end to end: U1 to U6", () => {
  const now = new Date();
  const w = world({ now });
  const sources = fakeSources(w);
  let folder = "";
  let keyFile = "";
  let db: TestDatabase;
  let outputs: Record<string, unknown> = {};
  let accounts: Record<string, SourceAccountId> = {};
  const tokens = { own: "", declassified: "", work: "" };
  let declassifiedClient = "";

  const admin = (): Env => ({ PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: keyFile });
  const reader = (): Env => ({ PI_DATABASE_URL_READER: db.urls.reader, PI_KEY_FILE: keyFile });
  const pipeline = (): Env => ({
    PI_DATABASE_URL_PIPELINE: db.urls.pipeline,
    PI_KEY_FILE: keyFile,
    PI_EXTRACT_MODEL: MODEL_ID,
  });
  const rows = <Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]> =>
    queryAs<Row>(db.urls.admin, text, values);
  const count = async (text: string, values?: unknown[]): Promise<number> =>
    (await rows<{ n: number }>(text, values))[0]?.n ?? -1;
  // A client's commitments, read through the store's Reader under its token: U1 is about the
  // beliefs, and their fact keys, which the wire form leaves out, are what it compares.
  const commitments = async (
    token: string,
    state: "open" | "closed" | "any",
  ): Promise<CommitmentList["commitments"]> => {
    const store = createReader({ url: db.urls.reader, keys: await loadKeys(keyFile), log: quiet });
    try {
      const answer = await store.getCommitments(token, { state, limit: 50 });
      if (!answer.ok) throw new Error(`get_commitments answered ${answer.code}`);
      return answer.value.commitments;
    } finally {
      await store.close();
    }
  };

  const sync = async (reset: "gmail"[] = []): Promise<void> => {
    const writer = createWriter({ url: db.urls.writer, keys: await loadKeys(keyFile), log: quiet });
    try {
      const result = await runSync({ writer, sources, log: quiet, now, reset });
      expect(
        result.outcomes.every((one) => one.outcome === "ok"),
        JSON.stringify(result.outcomes),
      ).toBe(true);
    } finally {
      await writer.close();
    }
  };
  const extract = async (): Promise<void> => {
    const result = await inProcess(["extract"], pipeline(), { deps: { model: fakeModelClient(outputs) } });
    expect(result.exit, result.stderr).toBe(0);
  };
  const ruling = async (argv: string[]): Promise<string> =>
    (JSON.parse(await ok(argv, admin())) as { ruling: string }).ruling;

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "pi-owner-rest-"));
    keyFile = join(folder, "keys.json");
    await ok(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile });
    db = await createTestDatabase({ keyFile });
    await sync();
    accounts = await gmailAccounts(db);
    outputs = worldModelOutputs(w, accounts);
    await withAdmin(db, (one) => one.secrets.setSecret("openrouter/key", SENTINEL_KEY));
    // The compartment's key is added before the first declassification.
    await ok(["keys", "add-compartment", "declassified"], { PI_KEY_FILE: keyFile });
    const add = async (name: string, compartments: string): Promise<string> =>
      (
        await ok(
          ["clients", "add", name, "--views", "self,people,work", "--tools", TOOLS, "--compartments", compartments],
          admin(),
        )
      ).trim();
    tokens.own = await add("own-only", "own");
    tokens.declassified = await add("own-declassified", "own,declassified");
    tokens.work = await add("work-only", "employer:example");
    const listed = JSON.parse(await ok(["clients", "list"], admin())) as ClientView[];
    declassifiedClient = listed.find((one) => one.name === "own-declassified")?.id ?? "";
    await extract();
  });

  afterAll(async () => {
    await db?.drop();
    if (folder !== "") await rm(folder, { recursive: true, force: true });
  });

  // A claim the owner may declassify: a source's, about no third party.
  const candidates = async (token: string): Promise<FactView[]> =>
    (await facts(reader(), token)).filter((one) => !one.thirdParty && one.message !== null);

  // The belief of a fact key computed under each client's clearance, as find_facts' belief read
  // serves it: the claims of its support the client reads, sorted, and its status. A clearance that
  // builds no belief of the key has none.
  const beliefsOf = async (factKey: string): Promise<{ audience: string[]; status: string; support: string[] }[]> => {
    const store = createReader({ url: db.urls.reader, keys: await loadKeys(keyFile), log: quiet });
    try {
      const found: { audience: string[]; status: string; support: string[] }[] = [];
      for (const [audience, token] of [
        [["employer:example"], tokens.work],
        [["own"], tokens.own],
        [["declassified", "own"], tokens.declassified],
      ] as const) {
        const answer = await store.findFacts(token, { belief: factKey as never, limit: 50 });
        if (!answer.ok || answer.value.facts.length === 0) continue;
        const statuses = [...new Set(answer.value.facts.map((one) => one.status ?? "none"))];
        if (statuses.length !== 1) throw new Error("one status for every claim of a belief's support");
        found.push({
          audience: [...audience],
          status: statuses[0] ?? "none",
          support: answer.value.facts.map((one) => one.id).sort(),
        });
      }
      return found;
    } finally {
      await store.close();
    }
  };

  const gate = (phase: string): void => {
    it(`U1 (${phase}): a rejected claim and a vetoed fact key change every audience's belief after one pi extract, and a lift restores them`, async () => {
      const [open] = await commitments(tokens.own, "open");
      if (open === undefined) throw new Error("the world has an open commitment");
      const factKey = open.belief.fact;
      const before = await beliefsOf(factKey);
      // The own client's audience sees the fact, at least.
      expect(before.map((one) => one.audience.join(","))).toContain("own");
      expect(before.every((one) => one.support.length > 0)).toBe(true);
      const claim = before[0]?.support[0] ?? "";
      expect(claim).toMatch(/^[0-9a-f]{64}$/);

      // A rejection: after one pi extract the claim is in no audience's support.
      const reject = await ruling(["correct", "reject", claim]);
      await extract();
      const rejected = await beliefsOf(factKey);
      expect(rejected.every((one) => !one.support.includes(claim))).toBe(true);
      await ok(["correct", "lift", reject], admin());
      await extract();
      expect(await beliefsOf(factKey)).toEqual(before);

      // A veto: after one pi extract the belief is closed in every audience.
      const veto = await ruling(["correct", "veto", claim]);
      await extract();
      const vetoed = await beliefsOf(factKey);
      expect(vetoed.map((one) => one.audience)).toEqual(before.map((one) => one.audience));
      expect(vetoed.every((one) => one.status === "closed")).toBe(true);
      for (const token of [tokens.own, tokens.declassified]) {
        expect((await commitments(token, "open")).map((one) => one.belief.fact)).not.toContain(factKey);
        expect((await commitments(token, "closed")).find((one) => one.belief.fact === factKey)?.belief.status).toBe(
          "closed",
        );
      }
      await ok(["correct", "lift", veto], admin());
      await extract();
      expect(await beliefsOf(factKey)).toEqual(before);
      expect((await commitments(tokens.own, "open")).map((one) => one.belief.fact)).toContain(factKey);
    });

    it(`U2 (${phase}): a declassified claim of employer:example is found by a client cleared for own and declassified, not by one cleared for own, and by neither after the revocation, which names the first client`, async () => {
      const [work] = await candidates(tokens.work);
      if (work === undefined) throw new Error("the world has a declassifiable work claim");
      const found = async (token: string): Promise<boolean> =>
        (await facts(reader(), token, { type: work.type })).some((one) => one.id === work.id);
      expect([await found(tokens.declassified), await found(tokens.own)]).toEqual([false, false]);

      const id = await ruling(["declassify", "add", work.id]);
      expect([await found(tokens.declassified), await found(tokens.own)]).toEqual([true, false]);
      // Found as the fact, with no message.
      expect(
        (await facts(reader(), tokens.declassified, { type: work.type })).find((one) => one.id === work.id)?.message,
      ).toBeNull();

      const revoked = JSON.parse(await ok(["declassify", "revoke", id], admin())) as { exposed: number };
      expect(revoked).toEqual({ exposed: 1 });
      expect([await found(tokens.declassified), await found(tokens.own)]).toEqual([false, false]);
      const [decision] = await rows<{ details: { exposed: string[] } }>(
        "select details from knowledge.owner_decisions where kind = 'declassify_revoke' order by decided_at desc, id desc limit 1",
      );
      expect(decision?.details.exposed).toEqual([declassifiedClient]);
      // The work client still reads it, as its own claim.
      expect(await found(tokens.work)).toBe(true);
    });

    it(`U3 (${phase}): an erased item and an item deleted at the source leave no declassified copy`, async () => {
      // Two claims of two items, the owner's first: U2 needs the work claim in the next phase.
      const pool = [...(await candidates(tokens.own)), ...(await candidates(tokens.work))];
      const chosen: FactView[] = [];
      const rulings: string[] = [];
      for (const fact of pool) {
        if (chosen.length === 2 || chosen.some((one) => one.message === fact.message)) continue;
        const added = await pi(["declassify", "add", fact.id], admin());
        if (added.exit !== 0) continue;
        chosen.push(fact);
        rulings.push((JSON.parse(added.stdout) as { ruling: string }).ruling);
      }
      const [erased, deleted] = chosen;
      if (erased === undefined || deleted === undefined) throw new Error("the world has two declassifiable items");
      const canaries = chosen.map((fact) =>
        fact.type === "transaction.receipt"
          ? fact.fields.merchant.untrusted
          : (("what" in fact.fields ? fact.fields.what?.untrusted : undefined) ?? ""),
      );
      expect(canaries.every((one) => one.length > 0)).toBe(true);
      expect(await count("select count(*)::int as n from projections.declassified_facts")).toBe(2);

      await ok(["erase", "item", erased.message ?? ""], admin());
      const byMessage = await gmailIds({ db, w, accounts });
      const gmailId = byMessage.get(deleted.message ?? "") ?? "";
      const source = sources.find(
        (one) => one.label === w.accounts.find((box) => box.messages.some((m) => m.id === gmailId))?.label,
      );
      if (source === undefined) throw new Error("the deleted item's mailbox");
      source.gmail.deletePermanently(gmailId);
      await sync();

      expect(await count("select count(*)::int as n from projections.declassified_facts")).toBe(0);
      expect(
        await count("select count(*)::int as n from knowledge.claims where id = any($1)", [
          chosen.map((one) => one.id),
        ]),
      ).toBe(0);
      expect(await scanForPlaintext(db.urls.admin, canaries)).toEqual([]);
      const listed = JSON.parse(await ok(["declassify", "list"], admin())) as { id: string; state: string }[];
      expect(listed.filter((one) => rulings.includes(one.id)).map((one) => one.state)).toEqual(["gone", "gone"]);
    });

    it(`U4 (${phase}): no agent API tool reaches anything of this item`, async () => {
      const tally = () =>
        rows<{ decisions: number; rulings: number; copies: number }>(
          "select (select count(*)::int from knowledge.owner_decisions) as decisions, (select count(*)::int from knowledge.belief_rulings) as rulings, (select count(*)::int from projections.declassified_facts) as copies",
        );
      const before = await tally();
      const [claim] = await candidates(tokens.own);
      for (const token of Object.values(tokens)) {
        const replies = await mcp(reader(), token, [
          { method: "tools/list" },
          ...OWNER_ONLY.map((name) => ({
            method: "tools/call",
            params: { name, arguments: { fact: claim?.id ?? "", claim: claim?.id ?? "" } },
          })),
        ]);
        expect((replies[0]?.result?.tools ?? []).map((one) => one.name).sort()).toEqual(TOOLS.split(",").sort());
        expect(replies.slice(1).map(outcome)).toEqual(OWNER_ONLY.map(() => ({ error: "not_permitted" })));
      }
      expect(await tally()).toEqual(before);
    });

    it.skipIf(!HAS_SCRIPT)(
      `U5 (${phase}): the page's API answers nothing without a session, refuses a forged Origin, a missing token and a foreign Host, serves a line holding markup as JSON text, and a decision made on it is the row pi decide writes`,
      async () => {
        const made = createAdmin({ url: db.urls.admin, keys: await loadKeys(keyFile), log: quiet });
        const marked = notice(MARKUP);
        const other = notice(null);
        try {
          await made.cards.raiseCard(marked);
          await made.cards.raiseCard(other);
        } finally {
          await made.close();
        }
        const socket = `${keyFile}.web`;
        const web = await servedWeb(admin(), socket);
        try {
          expect(await ask(socket, "/api/pendingCards")).toMatchObject({ status: 401, body: "" });
          const link = new URL(await web.link());
          const login = await ask(socket, `${link.pathname}${link.search}`);
          expect(login.status).toBe(303);
          // One use.
          expect((await ask(socket, `${link.pathname}${link.search}`)).status).toBe(401);
          const cookie = ([login.headers["set-cookie"] ?? []].flat()[0] ?? "").split(";")[0] ?? "";
          expect(await ask(socket, "/api/pendingCards", { cookie, host: "evil.example" })).toMatchObject({
            status: 421,
            body: "",
          });
          const card = await ask(socket, `/api/card?card=${marked.id}`, { cookie });
          expect(card.status).toBe(200);
          // Served as JSON, never as a page: the client renders it as text.
          expect(card.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect((JSON.parse(card.body) as { lines: unknown[] }).lines).toContainEqual({ text: MARKUP, from: "model" });
          const token = (JSON.parse((await ask(socket, "/api/session", { cookie })).body) as { token: string }).token;
          const body = { card: marked.id, answer: "acknowledge", requestId: requestId() };
          const decisions = () => count("select count(*)::int as n from knowledge.owner_decisions");
          const before = await decisions();
          expect(
            (await ask(socket, "/api/decide", { cookie, token, origin: "http://evil.example", json: body })).status,
          ).toBe(403);
          expect(
            (await ask(socket, "/api/decide", { cookie, origin: "http://localhost:8765", json: body })).status,
          ).toBe(403);
          expect(await decisions()).toBe(before);
          expect(
            (await ask(socket, "/api/decide", { cookie, token, origin: "http://localhost:8765", json: body })).status,
          ).toBe(200);
        } finally {
          await web.stop();
        }
        expect(existsSync(socket)).toBe(false);
        await ok(["decide", other.id, "--answer", "acknowledge"], admin());
        const written = await rows(
          "select card_id, kind, target_kind, target_id, answer, supersedes, batch, labels, details, compartments, body_enc from knowledge.owner_decisions where card_id = any($1) order by card_id",
          [[marked.id, other.id]],
        );
        expect(written).toHaveLength(2);
        const [first, second] = written.map(({ card_id: _card, ...rest }) => rest);
        expect(first).toMatchObject({ kind: "answer", batch: false });
        expect(first).toEqual(second);
      },
    );

    it(`U6 (${phase}): pi web link refuses when stdout is not a terminal, and the agent user cannot open the page's socket`, async (context) => {
      const refused = await pi(["web", "link"], admin());
      expect(refused).toEqual({
        exit: 1,
        stdout: "",
        stderr: `${JSON.stringify({ event: "command_failed", code: "not_a_terminal" })}\n`,
      });
      expect(existsSync(`${keyFile}.web`)).toBe(false);

      // The second half needs a second Unix user to try the socket as: root here, and an `agent`
      // or `nobody` user. The box's smoke check carries it otherwise.
      const other = ["agent", "nobody"]
        .map((name) => ({ name, id: spawnSync("id", ["-u", name], { encoding: "utf8" }) }))
        .find((one) => one.id.status === 0);
      if (process.getuid?.() !== 0 || other === undefined || !HAS_SCRIPT) {
        context.skip("needs root, a second Unix user and script: the box's smoke check carries this half");
        return;
      }
      const uid = Number(other.id.stdout.trim());
      const web = await servedWeb(admin(), `${keyFile}.web`);
      try {
        // The folder is opened to everyone, so only the socket's own mode stands in the way.
        await chmod(dirname(keyFile), 0o755);
        const tried = spawnSync(
          process.execPath,
          [
            "-e",
            `require("node:net").createConnection(${JSON.stringify(`${keyFile}.web`)}).on("connect", () => process.exit(0)).on("error", (e) => { console.log(e.code); process.exit(3) })`,
          ],
          {
            uid,
            gid: uid,
            encoding: "utf8",
          },
        );
        expect({ status: tried.status, code: tried.stdout.trim() }).toEqual({ status: 3, code: "EACCES" });
        // The positive control: pi's own user opens it.
        expect((await ask(`${keyFile}.web`, "/api/pendingCards")).status).toBe(401);
      } finally {
        await chmod(dirname(keyFile), 0o700);
        await web.stop();
      }
    });
  };

  describe("before the reset", () => gate("before the reset"));

  describe("after a full pi sync --reset gmail", () => {
    beforeAll(async () => {
      await sync(["gmail"]);
      await extract();
    });
    gate("after the reset");
  });
});
