import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import type {
  CardDetail,
  CardId,
  CardView,
  Digest,
  EntityId,
  LedgerEvent,
  PersonalLogEvent,
  PersonalLogger,
} from "@intelligence/contracts/personal";
import { Admin, AdminError } from "@intelligence/personal-store";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../commands.ts";
import { type Authenticator, assertion, authenticator, registration } from "../test-support/passkey-fixtures.ts";
import { control } from "../test-support/web-control.ts";
import { type Client, LINK_REFUSED, loadClient, MANIFEST, PLACEHOLDER } from "./web-client.ts";

// What a refused link login answers: the shell, marked as a refused link.
const REFUSED_LINK = PLACEHOLDER.toString("utf8").replace("<head>", `<head>${LINK_REFUSED}`);

import { startWeb, type Tailscale, tailscaleOf, type Web } from "./web.ts";
import { encodingFor, WEB_HEADERS } from "./web-answer.ts";
import { covers, NEVER_IN_A_BROWSER, READS, STREAMS, WRITES } from "./web-routes.ts";

// The owner's dashboard server without a database: its two sockets, the link from the control socket, sessions,
// the checks of Host, the Tailscale header, Origin and the token, the client's files, and the registry's reads and
// writes over a fake Admin that records each call. web.db.test.ts drives it on the real Admin.

const T0 = new Date("2026-09-15T12:00:00.000Z");
const MINUTE = 60_000;
const CARD = "crd_01J9ZZZZZZZZZZZZZZZZZZZZZA" as CardId;
const OTHER = "crd_01J9ZZZZZZZZZZZZZZZZZZZZZB" as CardId;
const ENTITY = "ent_01J9ZZZZZZZZZZZZZZZZZZZZZE" as EntityId;
const OTHER_ENTITY = "ent_01J9ZZZZZZZZZZZZZZZZZZZZZF" as EntityId;
const FACT = "f".repeat(64);
const RULING = "rul_01J9ZZZZZZZZZZZZZZZZZZZZZR";
const LEARNING = "lrn_01J9ZZZZZZZZZZZZZZZZZZZZZN";
const LIST = "lst_01J9ZZZZZZZZZZZZZZZZZZZZZW";
const GOAL = "gol_01J9ZZZZZZZZZZZZZZZZZZZZZG";
const LOCAL = "localhost:8765";
const TS: Tailscale = { host: "box.tail1234.ts.net", login: "owner@example.com" };
const SENTINEL_TEXT = "sentinel-goal-text-5b1d";

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
type Asked = {
  method?: string;
  host?: string;
  cookie?: string;
  origin?: string;
  token?: string;
  json?: unknown;
  raw?: string;
  type?: string;
  headers?: Record<string, string>;
};

// One request over the socket. `host` is the Host header, sent as given.
function ask(socket: string, path: string, options: Asked = {}): Promise<Answer> {
  const body = options.raw ?? (options.json === undefined ? undefined : JSON.stringify(options.json));
  const headers: Record<string, string> = { host: options.host ?? LOCAL, ...options.headers };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.token !== undefined) headers["x-pi-token"] = options.token;
  if (body !== undefined) headers["content-type"] = options.type ?? "application/json";
  return new Promise((resolve, reject) => {
    const sent = request(
      {
        socketPath: socket,
        path,
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        setHost: false,
      },
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

const view = (id: CardId): CardView => ({
  id,
  kind: "notice",
  state: "pending",
  author: "system:test",
  createdAt: T0.toISOString(),
  expiresAt: null,
  options: ["acknowledge"],
  target: null,
  refs: [],
});
const DIGEST: Digest = { pending: { notice: 2 }, deferred: 1, oldestPendingDays: 3, heldMessages: 4, withheldItems: 5 };

type Fake = { admin: Admin; calls: [string, unknown[]][]; answers: Record<string, (...args: never) => unknown> };

// The Admin's domain sub-objects (cards, facts, work and the rest), read off an Admin that never
// connects. A call through one is recorded as `group.method`, as the routes name it.
const GROUPS: ReadonlySet<string> = new Set(
  Object.keys(
    new Admin({ pool: {} as never, keys: {} as never, log: { info: () => {}, warn: () => {}, error: () => {} } }),
  ),
);

// Every Admin method, each call recorded by its group and name. A method with no answer here returns a ruling id.
function fakeAdmin(lines: CardDetail["lines"] = [{ text: "kind: notice", from: "code" }]): Fake {
  const calls: [string, unknown[]][] = [];
  const answers: Fake["answers"] = {
    "cards.digest": () => DIGEST,
    "cards.listPending": () => [view(CARD), view(OTHER)],
    "cards.card": (id: CardId) => (id === CARD ? { ...view(CARD), lines } : null),
    "people.entityPage": () => null,
    "facts.show": () => null,
    "ignores.listIgnore": () => [],
    "cards.listVetoes": () => [],
    "ignores.ignoredWho": () => new Map(),
    "names.who": () => new Map(),
    "facts.listFactRulings": () => [],
    "facts.latestClaims": () => new Map(),
    "cards.decide": (args: { cards: CardId[] }) => args.cards.map((card) => ({ card, ruling: RULING })),
  };
  const recorder = (prefix: string): object =>
    new Proxy(
      {},
      {
        get: (_, name) => {
          if (typeof name !== "string" || name === "then") return undefined;
          if (prefix === "" && GROUPS.has(name)) return recorder(`${name}.`);
          return async (...args: unknown[]) => {
            calls.push([`${prefix}${name}`, args]);
            const found = answers[`${prefix}${name}`] as ((...given: unknown[]) => unknown) | undefined;
            return found === undefined ? RULING : found(...args);
          };
        },
      },
    );
  return { admin: recorder("") as Admin, calls, answers };
}

const folders: string[] = [];
const servers: Web[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "pi-web-"));
  folders.push(made);
  return made;
}

const socketPath = async (): Promise<string> => join(await folder(), "keys.json.web");
const placeholder = (): Promise<Client> => loadClient(join(tmpdir(), "pi-web-no-client-here"));

type Started = { web: Web; socket: string; fake: Fake; logged: PersonalLogEvent[]; clock: { now: Date } };

async function started(
  options: {
    fake?: Fake;
    socket?: string;
    client?: Client;
    tailscale?: Tailscale;
    eventsMs?: number;
    driveCeilingBytes?: number;
    afterWrite?: () => Promise<void>;
  } = {},
): Promise<Started> {
  const socket = options.socket ?? (await socketPath());
  const fake = options.fake ?? fakeAdmin();
  const logged: PersonalLogEvent[] = [];
  const log: PersonalLogger = {
    info: (e) => logged.push(e),
    warn: (e) => logged.push(e),
    error: (e) => logged.push(e),
  };
  const clock = { now: T0 };
  const web = await startWeb({
    socket,
    admin: fake.admin,
    log,
    client: options.client ?? (await placeholder()),
    now: () => clock.now,
    // The name holds' sweep has its own test (owner-names.db.test.ts); here it would count as asking the Admin.
    nameHoldsMs: 0,
    // So would the relayed answers' pass (questions-through-agent.db.test.ts).
    relaysMs: 0,
    ...(options.eventsMs === undefined ? {} : { eventsMs: options.eventsMs }),
    ...(options.tailscale === undefined ? {} : { tailscale: options.tailscale }),
    ...(options.driveCeilingBytes === undefined ? {} : { driveCeilingBytes: options.driveCeilingBytes }),
    ...(options.afterWrite === undefined ? {} : { afterWrite: options.afterWrite }),
  });
  servers.push(web);
  return { web, socket, fake, logged, clock };
}

// Logs in with a new code from the control socket: the session cookie, as the browser sends it.
async function login(s: Started, host = LOCAL): Promise<string> {
  const code = await control(s.socket, "link");
  const headers = host === TS.host ? { "tailscale-user-login": TS.login } : undefined;
  const answer = await ask(s.socket, `/login?code=${code}`, { host, ...(headers === undefined ? {} : { headers }) });
  expect(answer.status).toBe(303);
  expect(answer.headers.location).toBe("/");
  const cookie = [answer.headers["set-cookie"] ?? []].flat()[0] ?? "";
  expect(cookie).toMatch(
    host === TS.host
      ? /^pi_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Secure$/
      : /^pi_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/,
  );
  return cookie.split(";")[0] ?? "";
}

const tokenOf = async (s: Started, cookie: string, host = LOCAL): Promise<string> => {
  const headers = host === TS.host ? { "tailscale-user-login": TS.login } : undefined;
  const answer = await ask(s.socket, "/api/session", { cookie, host, ...(headers === undefined ? {} : { headers }) });
  expect(answer.status).toBe(200);
  return (JSON.parse(answer.body) as { token: string }).token;
};

const decideBody = (extra: Record<string, unknown> = {}) => ({
  card: CARD,
  answer: "acknowledge",
  requestId: "req-web-0001",
  ...extra,
});
const calledNames = (fake: Fake): string[] => fake.calls.map(([name]) => name);

describe("A2: pi web's sockets", () => {
  // The page's socket is 0660, its group the process's (`piweb` on the box, set by `web-serve`);
  // the control socket is pi's alone.
  it("the page's socket is mode 0660 and the control socket 0600, and no TCP port is open", async (context) => {
    const tcp = ["/proc/self/net/tcp", "/proc/self/net/tcp6"].filter((file) => existsSync(file));
    const listening = (): string[] =>
      tcp.flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .slice(1)
          .filter((line) => line.trim().split(/\s+/)[3] === "0A")
          .map((line) => line.trim().split(/\s+/)[1] ?? ""),
      );
    const before = listening();
    const s = await started();
    for (const [path, mode] of [
      [s.socket, 0o660],
      [`${s.socket}-control`, 0o600],
    ] as const) {
      expect((await stat(path)).mode & 0o777, path).toBe(mode);
      expect((await stat(path)).isSocket(), path).toBe(true);
    }
    if (tcp.length === 0) {
      context.skip("no /proc/self/net on this system: the process's listening TCP sockets cannot be read");
      return;
    }
    expect(listening()).toEqual(before);
  });

  it("a second server is web_running, a stale socket is removed, and anything else is left alone", async () => {
    const s = await started();
    await expect(
      startWeb({
        socket: s.socket,
        admin: fakeAdmin().admin,
        log: { info() {}, warn() {}, error() {} },
        client: await placeholder(),
      }),
    ).rejects.toMatchObject({ code: "web_running" });
    expect((await ask(s.socket, "/api/digest")).status).toBe(401);
    const socket = await socketPath();
    // A process that listens on the socket and dies without removing it.
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => process.kill(process.pid, "SIGKILL"))`,
      ]);
      child.on("close", () => resolve());
    });
    const again = await started({ socket });
    expect((await ask(again.socket, "/api/digest")).status).toBe(401);
    const other = await socketPath();
    await writeFile(other, "not a socket");
    await expect(
      startWeb({
        socket: other,
        admin: fakeAdmin().admin,
        log: { info() {}, warn() {}, error() {} },
        client: await placeholder(),
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(readFileSync(other, "utf8")).toBe("not a socket");
  });

  it("it removes both sockets when it ends, and `stop` on the control socket ends it", async () => {
    const s = await started();
    expect(await control(s.socket, "stop")).toBe("ok");
    expect(await s.web.closed).toBe("stop");
    const other = await started();
    await other.web.close();
    expect(await other.web.closed).toBe("close");
    expect(existsSync(s.socket)).toBe(false);
    expect(existsSync(`${s.socket}-control`)).toBe(false);
    expect(s.logged.at(-1)).toEqual({ event: "web_stopped" });
  });
});

describe("A2: the link", () => {
  it("a code comes from the control socket, works once and not after 5 minutes, and a new one ends the last", async () => {
    const s = await started();
    // The server prints nothing and makes no code until asked.
    expect(await ask(s.socket, `/login?code=${"A".repeat(43)}`)).toMatchObject({ status: 401, body: REFUSED_LINK });
    const code = await control(s.socket, "link");
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await ask(s.socket, `/login?code=${code}`)).status).toBe(303);
    expect(await ask(s.socket, `/login?code=${code}`)).toMatchObject({ status: 401, body: REFUSED_LINK });
    const late = await control(s.socket, "link");
    s.clock.now = new Date(T0.getTime() + 5 * MINUTE + 1);
    expect(await ask(s.socket, `/login?code=${late}`)).toMatchObject({ status: 401, body: REFUSED_LINK });
    const replaced = await control(s.socket, "link");
    const newest = await control(s.socket, "link");
    expect(await ask(s.socket, `/login?code=${replaced}`)).toMatchObject({ status: 401, body: REFUSED_LINK });
    s.clock.now = new Date(s.clock.now.getTime() + 5 * MINUTE);
    expect((await ask(s.socket, `/login?code=${newest}`)).status).toBe(303);
    expect(await control(s.socket, "nonsense")).toBe("usage");
    // One word per connection: a second line mints no second code.
    const once = await control(s.socket, "link\nlink");
    expect(once).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await ask(s.socket, `/login?code=${once}`)).status).toBe(303);
    for (const one of [code, late, replaced, newest]) expect(JSON.stringify(s.logged)).not.toContain(one);
  });

  it("a refused link lands on the sign-in screen marked as refused, alike for a wrong, used or old code, and opens no session", async () => {
    const s = await started();
    const used = await control(s.socket, "link");
    expect((await ask(s.socket, `/login?code=${used}`)).status).toBe(303);
    const old = await control(s.socket, "link");
    s.clock.now = new Date(T0.getTime() + 5 * MINUTE + 1);
    const answers = await Promise.all(
      [`/login?code=${used}`, `/login?code=${old}`, `/login?code=${"A".repeat(43)}`, "/login"].map((path) =>
        ask(s.socket, path),
      ),
    );
    for (const answer of answers) {
      expect(answer).toMatchObject({ status: 401, body: REFUSED_LINK });
      expect(answer.headers["set-cookie"]).toBeUndefined();
      expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8");
    }
    expect(new Set(answers.map((answer) => answer.body)).size).toBe(1);
  });

  it("pi web link prints the link to a terminal only, at localhost or at the ts.net name; pi web stop ends the server", async () => {
    const keyFile = join(await folder(), "keys.json");
    const s = await started({ socket: `${keyFile}.web` });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const sink = (into: Buffer[]) =>
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          into.push(chunk);
          done();
        },
      });
    const env = { PI_DATABASE_URL_ADMIN: "postgres://pi_admin:sentinel@127.0.0.1:1/pi_test", PI_KEY_FILE: keyFile };
    const io = (tty: boolean) => ({ stdout: sink(out), stderr: sink(err), stdin: Readable.from([]), stdoutIsTTY: tty });
    expect(await run(["web", "link"], env, io(false))).toBe(1);
    expect(Buffer.concat(out).toString("utf8")).toBe("");
    expect(Buffer.concat(err).toString("utf8")).toBe(
      `${JSON.stringify({ event: "command_failed", code: "not_a_terminal" })}\n`,
    );
    expect(await run(["web", "link"], env, io(true))).toBe(0);
    expect(Buffer.concat(out).toString("utf8")).toMatch(/^http:\/\/localhost:8765\/login\?code=[A-Za-z0-9_-]{43}\n$/);
    out.length = 0;
    expect(await run(["web", "link"], { ...env, PI_WEB_TS_HOST: TS.host, PI_WEB_TS_LOGIN: TS.login }, io(true))).toBe(
      0,
    );
    const printed = Buffer.concat(out).toString("utf8");
    expect(printed).toMatch(/^https:\/\/box\.tail1234\.ts\.net\/login\?code=[A-Za-z0-9_-]{43}\n$/);
    // The printed code logs in once.
    const path = new URL(printed.trim()).pathname + new URL(printed.trim()).search;
    expect((await ask(s.socket, path)).status).toBe(303);
    expect(JSON.stringify(s.logged)).not.toContain(new URL(printed.trim()).searchParams.get("code"));
    expect(await run(["web", "stop"], env, io(false))).toBe(0);
    await s.web.closed;
    expect(existsSync(s.socket)).toBe(false);
    err.length = 0;
    expect(await run(["web", "link"], env, io(true))).toBe(1);
    expect(Buffer.concat(err).toString("utf8")).toBe(
      `${JSON.stringify({ event: "command_failed", code: "web_not_running" })}\n`,
    );
  });

  it("the ts.net name and the login are set together and well formed", () => {
    expect(tailscaleOf({})).toBeUndefined();
    expect(tailscaleOf({ PI_WEB_TS_HOST: TS.host, PI_WEB_TS_LOGIN: TS.login })).toEqual(TS);
    for (const env of [
      { PI_WEB_TS_HOST: TS.host },
      { PI_WEB_TS_LOGIN: TS.login },
      { PI_WEB_TS_HOST: "box.example.com", PI_WEB_TS_LOGIN: TS.login },
      { PI_WEB_TS_HOST: TS.host, PI_WEB_TS_LOGIN: "a b" },
    ]) {
      expect(() => tailscaleOf(env), JSON.stringify(env)).toThrow("usage");
    }
  });
});

describe("A2: sessions", () => {
  it("without a session every /api route answers 401 with an empty body and asks the Admin nothing; the shell loads", async () => {
    const s = await started();
    const routes = [
      ...Object.keys(READS).map((name) => ["GET", `/api/${name}`]),
      ...Object.keys(WRITES).map((name) => ["POST", `/api/${name}`]),
      ["GET", "/api/session"],
      ["GET", "/api/erase"],
    ];
    for (const [method, path] of routes) {
      for (const cookie of [undefined, `pi_session=${"A".repeat(43)}`]) {
        const answer = await ask(s.socket, path ?? "", {
          method: method ?? "GET",
          origin: `http://${LOCAL}`,
          ...(cookie === undefined ? {} : { cookie }),
        });
        expect(answer, `${method} ${path}`).toMatchObject({ status: 401, body: "" });
      }
    }
    expect(s.fake.calls).toEqual([]);
    for (const path of ["/", "/today", "/people/x"])
      expect(await ask(s.socket, path), path).toMatchObject({ status: 200, body: PLACEHOLDER.toString("utf8") });
    expect(await ask(s.socket, "/login")).toMatchObject({ status: 401, body: REFUSED_LINK });
  });

  it("one session per device: a new link login ends the last link session", async () => {
    const s = await started();
    const first = await login(s);
    expect((await ask(s.socket, "/api/digest", { cookie: first })).status).toBe(200);
    const second = await login(s);
    expect(await ask(s.socket, "/api/digest", { cookie: first })).toMatchObject({ status: 401, body: "" });
    expect((await ask(s.socket, "/api/digest", { cookie: second })).status).toBe(200);
  });

  it("idle is measured on the owner's actions, never on polling: 30 minutes for a link session, and 8 hours at most", async () => {
    const s = await started();
    const cookie = await login(s);
    // Polling within the 30 minutes keeps nothing alive.
    s.clock.now = new Date(T0.getTime() + 20 * MINUTE);
    expect((await ask(s.socket, "/api/digest", { cookie })).status).toBe(200);
    s.clock.now = new Date(T0.getTime() + 30 * MINUTE + 1);
    expect(await ask(s.socket, "/api/digest", { cookie })).toMatchObject({ status: 401, body: "" });
    // Each action does: a page loaded, a read marked as the owner's navigation, a write.
    const busy = await login(s);
    const token = await tokenOf(s, busy);
    const start = s.clock.now.getTime();
    const actions = [
      () => ask(s.socket, "/", { cookie: busy }),
      () => ask(s.socket, "/api/digest", { cookie: busy, headers: { "x-pi-action": "navigate" } }),
      () => ask(s.socket, "/api/decide", { cookie: busy, origin: `http://${LOCAL}`, token, json: decideBody() }),
    ];
    for (let n = 0; s.clock.now.getTime() + 29 * MINUTE < start + 8 * 60 * MINUTE; n += 1) {
      s.clock.now = new Date(s.clock.now.getTime() + 29 * MINUTE);
      expect((await actions[n % actions.length]?.())?.status, `action ${n}`).toBe(200);
    }
    // Kept busy to its last moment, it still ends 8 hours after the login.
    s.clock.now = new Date(start + 8 * 60 * MINUTE - 1);
    expect((await ask(s.socket, "/api/digest", { cookie: busy })).status).toBe(200);
    s.clock.now = new Date(start + 8 * 60 * MINUTE + 1);
    expect(await ask(s.socket, "/api/digest", { cookie: busy })).toMatchObject({ status: 401, body: "" });
  });
});

describe("A2: Host, the Tailscale header, Origin and the token", () => {
  const FOREIGN = [
    "evil.example",
    "localhost.evil.example:8765",
    "127.0.0.2:8765",
    "localhost:8765x",
    "localhost:",
    "other.tail1234.ts.net",
    `${TS.host}.evil.example`,
  ];

  it("without a ts.net name, only localhost and 127.0.0.1 are served; any other Host is 421 and reads nothing", async () => {
    const s = await started();
    const cookie = await login(s);
    for (const host of [...FOREIGN, TS.host]) {
      for (const path of ["/", "/api/digest", "/login?code=x"])
        expect(await ask(s.socket, path, { host, cookie }), `${host} ${path}`).toMatchObject({ status: 421, body: "" });
    }
    expect(s.fake.calls).toEqual([]);
    for (const host of ["localhost", "127.0.0.1:1234", LOCAL])
      expect((await ask(s.socket, "/api/digest", { host, cookie })).status, host).toBe(200);
  });

  it("with a ts.net name set, it is the one Host: the localhost names are refused too", async () => {
    const s = await started({ tailscale: TS });
    const cookie = await login(s, TS.host);
    const headers = { "tailscale-user-login": TS.login };
    for (const host of [...FOREIGN, "localhost", "127.0.0.1:1234", LOCAL]) {
      for (const path of ["/", "/api/digest", "/login?code=x"])
        expect(await ask(s.socket, path, { host, cookie, headers }), `${host} ${path}`).toMatchObject({
          status: 421,
          body: "",
        });
    }
    expect(s.fake.calls).toEqual([]);
    expect((await ask(s.socket, "/api/digest", { host: TS.host, cookie, headers })).status).toBe(200);
  });

  it("through tailscale serve: the backend Host with the ts.net name forwarded is served; any other forwarded name is 421", async () => {
    const s = await started({ tailscale: TS });
    const cookie = await login(s, TS.host);
    const through = (forwarded: string) => ({ "tailscale-user-login": TS.login, "x-forwarded-host": forwarded });
    expect((await ask(s.socket, "/api/digest", { host: "localhost", cookie, headers: through(TS.host) })).status).toBe(
      200,
    );
    for (const forwarded of FOREIGN)
      expect(
        await ask(s.socket, "/api/digest", { host: "localhost", cookie, headers: through(forwarded) }),
        forwarded,
      ).toMatchObject({ status: 421, body: "" });
  });

  it("on the ts.net Host the Tailscale header must name the owner's login, and without a ts.net name it is refused", async () => {
    const s = await started({ tailscale: TS });
    const cookie = await login(s, TS.host);
    for (const headers of [{}, { "tailscale-user-login": "someone@example.com" }, { "tailscale-user-login": "" }]) {
      for (const path of ["/", "/api/digest", "/login?code=x"])
        expect(
          await ask(s.socket, path, { host: TS.host, cookie, headers }),
          `${JSON.stringify(headers)} ${path}`,
        ).toMatchObject({ status: 403, body: "" });
    }
    const plain = await started();
    const local = await login(plain);
    for (const path of ["/", "/api/digest"])
      expect(
        await ask(plain.socket, path, { cookie: local, headers: { "tailscale-user-login": TS.login } }),
        path,
      ).toMatchObject({ status: 403, body: "" });
    expect([...s.fake.calls, ...plain.fake.calls]).toEqual([]);
  });

  it("a sessionless request on the ts.net Host gets the shell and the link login only; every /api route answers 401", async () => {
    const s = await started({ tailscale: TS });
    const headers = { "tailscale-user-login": TS.login };
    expect(await ask(s.socket, "/", { host: TS.host, headers })).toMatchObject({
      status: 200,
      body: PLACEHOLDER.toString("utf8"),
    });
    for (const name of [...Object.keys(READS), "session"])
      expect(await ask(s.socket, `/api/${name}`, { host: TS.host, headers }), name).toMatchObject({
        status: 401,
        body: "",
      });
    for (const name of Object.keys(WRITES))
      expect(
        await ask(s.socket, `/api/${name}`, { host: TS.host, headers, origin: `https://${TS.host}`, json: {} }),
        name,
      ).toMatchObject({ status: 401, body: "" });
    expect(s.fake.calls).toEqual([]);
  });

  it("a write with a wrong Origin, or without the session's token, is 403 and writes nothing; on the ts.net Host the Origin is https", async () => {
    const s = await started();
    const cookie = await login(s);
    const token = await tokenOf(s, cookie);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const origin of [undefined, "null", "http://evil.example", "http://localhost:9999", `https://${LOCAL}`]) {
      expect(
        await ask(s.socket, "/api/decide", {
          cookie,
          token,
          json: decideBody(),
          ...(origin === undefined ? {} : { origin }),
        }),
        String(origin),
      ).toMatchObject({ status: 403, body: "" });
    }
    for (const bad of [undefined, "A".repeat(43), `${token}x`]) {
      expect(
        await ask(s.socket, "/api/decide", {
          cookie,
          origin: `http://${LOCAL}`,
          json: decideBody(),
          ...(bad === undefined ? {} : { token: bad }),
        }),
        String(bad),
      ).toMatchObject({ status: 403, body: "" });
    }
    // The token in the body, as a form had it, is no token.
    expect(
      (await ask(s.socket, "/api/decide", { cookie, origin: `http://${LOCAL}`, json: decideBody({ token }) })).status,
    ).toBe(403);
    expect(calledNames(s.fake)).toEqual([]);
    // The positive control.
    expect(
      (await ask(s.socket, "/api/decide", { cookie, token, origin: `http://${LOCAL}`, json: decideBody() })).status,
    ).toBe(200);
    // On the ts.net Host the Origin is https.
    const t = await started({ tailscale: TS });
    const secure = await login(t, TS.host);
    const secureToken = await tokenOf(t, secure, TS.host);
    const headers = { "tailscale-user-login": TS.login };
    expect(
      (
        await ask(t.socket, "/api/decide", {
          host: TS.host,
          headers,
          cookie: secure,
          token: secureToken,
          origin: `http://${TS.host}`,
          json: decideBody(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await ask(t.socket, "/api/decide", {
          host: TS.host,
          headers,
          cookie: secure,
          token,
          origin: `https://${TS.host}`,
          json: decideBody(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await ask(t.socket, "/api/decide", {
          host: TS.host,
          headers,
          cookie: secure,
          token: secureToken,
          origin: `https://${TS.host}`,
          json: decideBody(),
        })
      ).status,
    ).toBe(200);
    expect([...calledNames(s.fake), ...calledNames(t.fake)]).toEqual(["cards.decide", "cards.decide"]);
  });

  it("a body that is not JSON, or over the limit, is refused with its answer and writes nothing", async () => {
    const s = await started();
    const cookie = await login(s);
    const token = await tokenOf(s, cookie);
    const post = (options: Asked) =>
      ask(s.socket, "/api/decide", { cookie, token, origin: `http://${LOCAL}`, ...options });
    expect(await post({ raw: "answer=acknowledge", type: "application/x-www-form-urlencoded" })).toMatchObject({
      status: 400,
      body: '{"refused":"usage"}',
    });
    expect((await post({ raw: "{not json" })).status).toBe(400);
    expect((await post({ json: decideBody({ note: "x".repeat(20_000) }) })).status).toBe(400);
    expect(s.fake.calls).toEqual([]);
  });
});

describe("A2: what is served", () => {
  it("every answer carries the four headers, the dashboard's content security policy among them", async () => {
    const s = await started();
    const answers: Answer[] = [
      await ask(s.socket, "/api/digest"),
      await ask(s.socket, "/", { host: "evil.example" }),
      await ask(s.socket, "/"),
    ];
    const cookie = await login(s);
    const token = await tokenOf(s, cookie);
    answers.push(await ask(s.socket, "/api/digest", { cookie }));
    answers.push(await ask(s.socket, `/api/card?card=${OTHER}`, { cookie }));
    answers.push(await ask(s.socket, "/api/erase", { cookie }));
    answers.push(await ask(s.socket, "/api/decide", { cookie, json: decideBody() }));
    answers.push(
      await ask(s.socket, "/api/decide", { cookie, token, origin: `http://${LOCAL}`, json: { card: CARD } }),
    );
    answers.push(await ask(s.socket, "/api/decide", { cookie, token, origin: `http://${LOCAL}`, json: decideBody() }));
    answers.push(await ask(s.socket, "/api/digest", { cookie, method: "POST" }));
    answers.push(await ask(s.socket, `/login?code=${await control(s.socket, "link")}`));
    expect(answers.map((one) => one.status)).toEqual([401, 421, 200, 200, 404, 404, 403, 400, 200, 405, 303]);
    for (const answer of answers)
      for (const [name, value] of Object.entries(WEB_HEADERS))
        expect(answer.headers[name.toLowerCase()], name).toBe(value);
    expect(WEB_HEADERS).toEqual({
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'",
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("the client's shell and assets come from the manifest, read once at start; without one the placeholder holds no script", async () => {
    expect(PLACEHOLDER.toString("utf8")).not.toMatch(/<script|\son[a-z]+=/i);
    const dist = await folder();
    await mkdir(join(dist, "assets"));
    await writeFile(
      join(dist, "index.html"),
      `<!doctype html><script type="module" src="/assets/app-1a2b.js"></script>`,
    );
    await writeFile(join(dist, "assets", "app-1a2b.js"), "export {};");
    await writeFile(join(dist, "assets", "app-3c4d.css"), "body{}");
    await writeFile(join(dist, "secret.txt"), "not listed");
    const JS = "text/javascript; charset=utf-8";
    const html = { "/index.html": { file: "index.html", type: "text/html; charset=utf-8" } };
    const assets = {
      ...html,
      "/assets/app-1a2b.js": { file: "assets/app-1a2b.js", type: JS },
      "/assets/app-3c4d.css": { file: "assets/app-3c4d.css", type: "text/css; charset=utf-8" },
    };
    // As pi-web-client's build writes it.
    await writeFile(join(dist, MANIFEST), JSON.stringify({ index: "index.html", assets }));
    const s = await started({ client: await loadClient(dist) });
    // Changed on disk after the start: still the files read at it.
    await writeFile(join(dist, "assets", "app-1a2b.js"), "changed");
    expect(await ask(s.socket, "/assets/app-1a2b.js")).toMatchObject({
      status: 200,
      body: "export {};",
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
    expect(await ask(s.socket, "/assets/app-3c4d.css")).toMatchObject({
      status: 200,
      body: "body{}",
      headers: { "content-type": "text/css; charset=utf-8" },
    });
    for (const path of ["/", "/secret.txt", "/assets/../secret.txt", "/work"]) {
      expect(await ask(s.socket, path), path).toMatchObject({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: expect.stringContaining("app-1a2b.js"),
      });
    }
    expect((await ask(s.socket, "/", { method: "POST" })).status).toBe(405);
    // A manifest that names a path outside the folder, or a file of no known type, refuses the start.
    for (const manifest of [
      { index: "index.html", assets: { "/keys.json": { file: "../keys.json", type: JS } } },
      { index: "index.html", assets: { "/secret.txt": { file: "secret.txt", type: "text/plain" } } },
      { index: "index.html", assets: { "/api/digest": { file: "assets/app-1a2b.js", type: JS } } },
      {
        index: "index.html",
        assets: { "/assets/app-1a2b.js": { file: "assets/app-1a2b.js", type: JS, br: "../keys.json" } },
      },
      {
        index: "index.html",
        assets: { "/assets/app-1a2b.js": { file: "assets/app-1a2b.js", type: JS, gzip: "assets/app-3c4d.css" } },
      },
      { index: "index.html", assets: { "/../secret.txt": { file: "secret.txt", type: JS } } },
      { index: "assets/app-1a2b.js", assets: {} },
      { index: "index.html", assets: ["assets/app-1a2b.js"] },
      { assets: {} },
      "nonsense",
    ]) {
      await writeFile(join(dist, MANIFEST), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
      await expect(loadClient(dist), JSON.stringify(manifest)).rejects.toMatchObject({ code: "bad_client_manifest" });
    }
    // A folder named by PI_WEB_CLIENT_DIR must hold a manifest.
    await expect(loadClient(join(dist, "nowhere"), { required: true })).rejects.toMatchObject({
      code: "no_client_manifest",
    });
  });
});

describe("loading fast: encodings and what the browser may keep", () => {
  type Raw = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
  const raw = (socket: string, path: string, headers: Record<string, string> = {}): Promise<Raw> =>
    new Promise((resolve, reject) => {
      const sent = request(
        { socketPath: socket, path, method: "GET", headers: { host: LOCAL, ...headers }, setHost: false },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      sent.on("error", reject);
      sent.end();
    });
  const JS = "text/javascript; charset=utf-8";
  const HTML = "text/html; charset=utf-8";
  const CODE = `export const rooms = ${JSON.stringify(Array.from({ length: 200 }, (_, index) => `room ${index}`))};`;
  const PAGE = `<!doctype html><script type="module" src="/assets/app-1a2b3c4d.js"></script>${"<!-- the page -->".repeat(100)}`;

  // A built client as pi-web-client's build writes it: text with its two copies, a font without.
  async function built(): Promise<Client> {
    const dist = await folder();
    await mkdir(join(dist, "assets"));
    const files: Record<string, string | Buffer> = {
      "index.html": PAGE,
      "index.html.br": brotliCompressSync(PAGE),
      "index.html.gz": gzipSync(PAGE),
      "assets/app-1a2b3c4d.js": CODE,
      "assets/app-1a2b3c4d.js.br": brotliCompressSync(CODE),
      "assets/app-1a2b3c4d.js.gz": gzipSync(CODE),
      "assets/Serif-5e6f7a8b.woff2": Buffer.from([0x77, 0x4f, 0x46, 0x32]),
      "icon-32.png": Buffer.from([0x89, 0x50]),
    };
    for (const [name, body] of Object.entries(files)) await writeFile(join(dist, name), body);
    const assets = {
      "/index.html": { file: "index.html", type: HTML, br: "index.html.br", gzip: "index.html.gz" },
      "/assets/app-1a2b3c4d.js": {
        file: "assets/app-1a2b3c4d.js",
        type: JS,
        br: "assets/app-1a2b3c4d.js.br",
        gzip: "assets/app-1a2b3c4d.js.gz",
      },
      "/assets/Serif-5e6f7a8b.woff2": { file: "assets/Serif-5e6f7a8b.woff2", type: "font/woff2" },
      "/icon-32.png": { file: "icon-32.png", type: "image/png" },
    };
    await writeFile(join(dist, MANIFEST), JSON.stringify({ index: "index.html", assets }));
    return loadClient(dist);
  }

  it("encodingFor takes brotli, then gzip, and neither when refused", () => {
    expect(encodingFor("gzip, deflate, br, zstd")).toBe("br");
    expect(encodingFor("gzip;q=1.0, br;q=0")).toBe("gzip");
    expect(encodingFor("BR;q=0.5")).toBe("br");
    expect(encodingFor("*")).toBe("br");
    expect(encodingFor("*, br;q=0")).toBe("gzip");
    // The browser's weights choose, brotli on a tie.
    expect(encodingFor("gzip;q=1, br;q=0.1")).toBe("gzip");
    expect(encodingFor("gzip;q=0.5, br;q=0.5")).toBe("br");
    expect(encodingFor("identity")).toBeNull();
    expect(encodingFor("")).toBeNull();
    expect(encodingFor(undefined)).toBeNull();
  });

  it("a file the build compressed goes in the best encoding accepted, with Vary, and opens to the file", async () => {
    const s = await started({ client: await built() });
    const br = await raw(s.socket, "/assets/app-1a2b3c4d.js", { "accept-encoding": "gzip, deflate, br" });
    expect(br.headers).toMatchObject({ "content-encoding": "br", vary: "Accept-Encoding", "content-type": JS });
    expect(brotliDecompressSync(br.body).toString("utf8")).toBe(CODE);
    expect(br.body.length).toBeLessThan(CODE.length / 4);
    const gz = await raw(s.socket, "/assets/app-1a2b3c4d.js", { "accept-encoding": "gzip" });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gz.body).toString("utf8")).toBe(CODE);
    const plain = await raw(s.socket, "/assets/app-1a2b3c4d.js");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers.vary).toBe("Accept-Encoding");
    expect(plain.body.toString("utf8")).toBe(CODE);
    // The shell, at every page path, compressed too; a font goes as it is.
    const page = await raw(s.socket, "/work", { "accept-encoding": "br" });
    expect(page.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(page.body).toString("utf8")).toBe(PAGE);
    const font = await raw(s.socket, "/assets/Serif-5e6f7a8b.woff2", { "accept-encoding": "br" });
    expect(font.headers["content-encoding"]).toBeUndefined();
    expect(font.headers.vary).toBeUndefined();
  });

  it("files under /assets/ are kept a year as immutable; the shell, other files and every answer of data stay no-store; the security headers are on all", async () => {
    const s = await started({ client: await built() });
    const KEPT = "public, max-age=31536000, immutable";
    for (const path of ["/assets/app-1a2b3c4d.js", "/assets/Serif-5e6f7a8b.woff2"])
      expect((await raw(s.socket, path)).headers["cache-control"], path).toBe(KEPT);
    const cookie = await login(s);
    const answers = await Promise.all(
      ["/", "/work", "/index.html", "/icon-32.png", "/assets/missing-00000000.js", "/assets/../index.html"]
        .map((path) => raw(s.socket, path))
        .concat([raw(s.socket, "/api/digest", { cookie }), raw(s.socket, "/api/session", { cookie })]),
    );
    for (const answer of answers) expect(answer.headers["cache-control"]).toBe("no-store");
    // A file under /assets/ this build does not hold is 404, never the shell (a tab open across a
    // new build asking for the last build's room); the rest are what they were.
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 404, 200, 200, 200]);
    for (const answer of [...answers, await raw(s.socket, "/assets/app-1a2b3c4d.js", { "accept-encoding": "br" })]) {
      for (const [name, value] of Object.entries(WEB_HEADERS))
        if (name !== "Cache-Control") expect(answer.headers[name.toLowerCase()], name).toBe(value);
    }
  });

  it("a long read's answer is compressed for a browser that accepts it; a short one, the session's token and a refusal are not", async () => {
    const fake = fakeAdmin();
    fake.answers["cards.listPending"] = () => Array.from({ length: 20 }, () => view(CARD));
    const s = await started({ fake });
    const cookie = await login(s);
    const long = await raw(s.socket, "/api/pendingCards?limit=20", { cookie, "accept-encoding": "gzip, br" });
    expect(long.headers).toMatchObject({
      "content-encoding": "br",
      vary: "Accept-Encoding",
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    const opened = brotliDecompressSync(long.body).toString("utf8");
    expect(JSON.parse(opened)).toEqual(Array.from({ length: 20 }, () => view(CARD)));
    expect(long.body.length).toBeLessThan(opened.length / 4);
    const gz = await raw(s.socket, "/api/pendingCards?limit=20", { cookie, "accept-encoding": "gzip" });
    expect(JSON.parse(gunzipSync(gz.body).toString("utf8"))).toHaveLength(20);
    const none = await raw(s.socket, "/api/pendingCards?limit=20", { cookie });
    expect(none.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(none.body.toString("utf8"))).toHaveLength(20);
    for (const path of ["/api/digest", "/api/session", `/api/card?card=${OTHER}`]) {
      expect(
        (await raw(s.socket, path, { cookie, "accept-encoding": "br" })).headers["content-encoding"],
        path,
      ).toBeUndefined();
    }
  });
});

describe("A2: the registry's reads and writes", () => {
  it("a read is GET /api/<read> with its arguments in the query, and answers the Admin's result as JSON", async () => {
    const s = await started();
    const cookie = await login(s);
    expect(JSON.parse((await ask(s.socket, "/api/digest", { cookie })).body)).toEqual(DIGEST);
    expect(JSON.parse((await ask(s.socket, "/api/pendingCards?limit=2&kind=notice", { cookie })).body)).toEqual([
      view(CARD),
      view(OTHER),
    ]);
    expect(JSON.parse((await ask(s.socket, `/api/card?card=${CARD}`, { cookie })).body)).toMatchObject({
      id: CARD,
      lines: [{ text: "kind: notice", from: "code" }],
    });
    expect(await ask(s.socket, `/api/entityPage?entity=${ENTITY}`, { cookie })).toMatchObject({
      status: 404,
      body: '{"refused":"not_found"}',
    });
    expect(s.fake.calls).toEqual([
      ["cards.digest", []],
      ["cards.listPending", [{ kind: "notice", limit: 2 }]],
      ["cards.card", [CARD, { view: "web" }]],
      ["people.entityPage", [ENTITY]],
    ]);
    // Arguments not of the read's shape, named twice, or a write's method, ask nothing.
    for (const path of [
      "/api/card?card=nonsense",
      "/api/card",
      `/api/card?card=${CARD}&card=${OTHER}`,
      `/api/card?card=${CARD}&extra=1`,
      "/api/digest?x=1",
      "/api/pendingCards?limit=0",
    ]) {
      expect(await ask(s.socket, path, { cookie }), path).toMatchObject({ status: 400, body: '{"refused":"usage"}' });
    }
    expect((await ask(s.socket, "/api/digest", { cookie, method: "POST" })).status).toBe(405);
    expect(s.fake.calls).toHaveLength(4);
  });

  it("the reads that existed before the dashboard: status against the host's Drive ceiling, paged tiers, one piece of work's chain", async () => {
    const opportunity = `opp_${"0".repeat(26)}`;
    const move = `mov_${"1".repeat(26)}`;
    const at = "2026-10-28T10:00:00.000Z";
    const events = [{ event: "handed_to_owner", at, by: "owner", code: null }];
    const shown = {
      kind: "opportunity",
      id: opportunity,
      workKind: "research",
      about: { kind: "entity", id: ENTITY },
      by: "owner",
      at,
      compartments: ["own"],
      tainted: false,
      summary: "<b>an agent's words</b>",
      details: { plan: "read the thread" },
      basis: [{ kind: "entity", id: ENTITY, tainted: false }],
      events,
      decisions: [{ decision: "go", by: "owner", rung: 4, reason: "owner_task", intent: null, ruling: null, at }],
      moves: [
        {
          kind: "move",
          id: move,
          opportunity,
          stage: "investigate",
          by: "agent-one",
          at,
          intent: "int_x",
          events,
          reports: [{ at, summary: null, report: { deliverable: "found it" }, marks: [] }],
        },
      ],
      intentions: [],
    };
    const fake = fakeAdmin();
    fake.answers["work.showWork"] = () => shown;
    const s = await started({ fake, driveCeilingBytes: 1024 });
    const cookie = await login(s);
    await ask(s.socket, "/api/status", { cookie });
    await ask(s.socket, "/api/peopleTiers?tier=close", { cookie });
    expect(await ask(s.socket, `/api/showWork?work=${opportunity}`, { cookie })).toMatchObject({
      status: 200,
      body: JSON.stringify(shown),
    });
    expect(s.fake.calls).toEqual([
      // Settings shows no table's count, so the page's status takes the catalogue's estimates and counts none.
      ["accounts.status", [{ tables: "estimate", driveCeilingBytes: 1024 }]],
      ["tiers.peopleTiers", [{ tier: "close", limit: 50 }]],
      ["work.showWork", [opportunity]],
    ]);
    // Only an id of work, and an entity id for a person: free text asks nothing.
    for (const path of [
      "/api/showWork?work=anything",
      `/api/showWork?work=${ENTITY}`,
      "/api/personWarmth?entity=someone@example.com",
    ]) {
      expect(await ask(s.socket, path, { cookie }), path).toMatchObject({ status: 400, body: '{"refused":"usage"}' });
    }
    expect(s.fake.calls).toHaveLength(3);
  });

  it("the System room's reads: the stored measures with this server's commit, and the open defects alone", async () => {
    const s = await started();
    const cookie = await login(s);
    const at = T0.toISOString();
    const measure = {
      metric: "credited_share",
      state: "failing",
      value: 0.12,
      sample: 340,
      readAt: at,
      healthy: { test: "at_least", value: 0.7 },
      minSample: 60,
      failingSince: at,
      stale: false,
    };
    const open = {
      improvement: "imp_01J9ZZZZZZZZZZZZZZZZZZZZZM",
      kind: "bug",
      severity: "high",
      area: "work",
      status: "in_progress",
      role: "engineering",
      heldBy: "sable",
      fixRef: null,
      filedAt: at,
      days: 3,
      reports: 2,
      ownersToChange: false,
    };
    s.fake.answers["box.measures"] = () => ({ at, measures: [measure] });
    // One role's defect tasks, all held to a date by one agent.
    s.fake.answers["box.defectHolds"] = () => [{ role: "engineering", agent: "sable", tasks: 5 }];
    // The words of the one an agent filed; none are kept for the system's.
    s.fake.answers["box.defectWords"] = () => ({
      imp_01J9ZZZZZZZZZZZZZZZZZZZZZN: { title: "The timeline misses a day", detail: null, evidence: null },
      imp_01J9ZZZZZZZZZZZZZZZZZZZZZM: { title: SENTINEL_TEXT, detail: null, evidence: null },
    });
    // The store's view holds more than the page is served: its counts by status and its causes.
    s.fake.answers["box.improvements"] = () => ({
      at,
      total: 5,
      open: 2,
      byStatus: { open: 1, in_progress: 1, done: 3 },
      causes: [{ cause: "measure_floor:credited_share", measures: SENTINEL_TEXT }],
      servedTo: [],
      defectRole: null,
      ownersToChange: 0,
      defects: [
        { ...open, cause: "measure_floor:credited_share" },
        { ...open, improvement: "imp_01J9ZZZZZZZZZZZZZZZZZZZZZN", heldBy: null, cause: null },
      ],
    });
    const system = await ask(s.socket, "/api/system", { cookie });
    expect(JSON.parse(system.body)).toEqual({
      at,
      measures: [measure],
      commit: expect.stringMatching(/^([0-9a-f]{7,40}|unknown)$/),
    });
    const defects = await ask(s.socket, "/api/defects", { cookie });
    expect(JSON.parse(defects.body)).toEqual({
      at,
      total: 5,
      open: 2,
      // No agent is assigned the defects, and none is marked the owner's to change.
      defectRole: null,
      ownersToChange: 0,
      heldByOne: [{ role: "engineering", agent: "sable", tasks: 5 }],
      defects: [
        { ...open, cause: "measure_floor:credited_share", filedBy: "system", words: null },
        {
          ...open,
          improvement: "imp_01J9ZZZZZZZZZZZZZZZZZZZZZN",
          heldBy: null,
          cause: null,
          filedBy: "agent",
          // What the agent wrote, marked as its words; what it did not write is null.
          words: { title: { untrusted: "The timeline misses a day" }, detail: null, evidence: null },
        },
      ],
    });
    expect(defects.body).not.toContain(SENTINEL_TEXT);
    expect(s.fake.calls).toEqual([
      ["box.measures", []],
      ["box.improvements", []],
      ["box.defectWords", []],
      ["box.defectHolds", []],
    ]);
    // A defect not of the page's shape is never served.
    s.fake.answers["box.improvements"] = () => ({
      at,
      total: 1,
      open: 1,
      defects: [{ ...open, cause: null, title: SENTINEL_TEXT }],
    });
    expect((await ask(s.socket, "/api/defects", { cookie })).body).not.toContain(SENTINEL_TEXT);
  });

  it("the Projects room's read and who is on what: the Admin's answer in the registry's shape, an agent's words marked as its", async () => {
    const s = await started();
    const cookie = await login(s);
    const at = T0.toISOString();
    const held = {
      opportunity: "opp_01J9ZZZZZZZZZZZZZZZZZZZZZT",
      kind: "research",
      task: true,
      status: "claimed",
      role: "research",
      holder: "sable",
      lapsed: false,
      lapsedAt: null,
      theirsUntil: null,
      since: at,
      project: ENTITY,
      dueAt: null,
      summary: { untrusted: SENTINEL_TEXT },
      progress: { done: [{ untrusted: "one" }], next: null, waitingOn: null, resumeAt: null, at, by: "sable" },
      parkedBy: null,
      parkedUntil: null,
    };
    const projects = {
      at,
      more: false,
      // An area's name is the owner's words, marked as a project's is.
      areas: [{ key: "field-work", name: { untrusted: SENTINEL_TEXT }, retired: false }],
      projects: [
        {
          id: ENTITY,
          name: { untrusted: SENTINEL_TEXT },
          status: {
            value: "active",
            asOf: at,
            by: { kind: "owner" },
            disputedBy: [{ value: "blocked", asOf: at, by: { kind: "agent", client: "sable" } }],
          },
          ownerRole: "research",
          goal: null,
          dueAt: null,
          createdAt: at,
          updatedAt: at,
          createdBy: "sable",
          area: "field-work",
          work: [held],
          changes: [{ kind: "work", at, opportunity: held.opportunity, event: "claimed" }],
          more: false,
        },
      ],
    };
    s.fake.answers["projects.overview"] = () => projects;
    s.fake.answers["agents.longWork"] = () => ({ at, work: [held], more: false });
    expect(JSON.parse((await ask(s.socket, "/api/projects", { cookie })).body)).toEqual(projects);
    expect(JSON.parse((await ask(s.socket, "/api/longWork", { cookie })).body)).toEqual({
      at,
      work: [held],
      more: false,
    });
    expect(s.fake.calls).toEqual([
      ["projects.overview", []],
      ["agents.longWork", []],
    ]);
    // Neither takes an argument, and a name or a line reaches no log.
    expect((await ask(s.socket, `/api/projects?project=${ENTITY}`, { cookie })).status).toBe(400);
    expect(JSON.stringify(s.logged)).not.toContain(SENTINEL_TEXT);
    // A line not marked as the agent's is never served.
    s.fake.answers["agents.longWork"] = () => ({ at, work: [{ ...held, summary: SENTINEL_TEXT }], more: false });
    expect((await ask(s.socket, "/api/longWork", { cookie })).body).not.toContain(SENTINEL_TEXT);
  });

  it("a result not of the registry's shape is never served", async () => {
    const fake = fakeAdmin();
    fake.answers["cards.digest"] = () => ({ ...DIGEST, secret: "x" });
    const s = await started({ fake });
    const cookie = await login(s);
    expect(await ask(s.socket, "/api/digest", { cookie })).toMatchObject({
      status: 500,
      body: '{"refused":"unavailable"}',
    });
    expect(s.logged).toContainEqual({ event: "web_bad_result", code: "digest" });
  });

  it("every write is one Admin call with its body, and the registry's fixed arguments, never the body's", async () => {
    const s = await started();
    const cookie = await login(s);
    const token = await tokenOf(s, cookie);
    const post = (name: string, json: unknown) =>
      ask(s.socket, `/api/${name}`, { cookie, token, origin: `http://${LOCAL}`, json });
    const r = { requestId: "req-web-0002" };
    const bodies: Record<keyof typeof WRITES, [Record<string, unknown>, string, unknown[]]> = {
      decide: [
        decideBody({ labels: ["correct"], reason: undefined }),
        "cards.decide",
        [{ cards: [CARD], answer: "acknowledge", labels: ["correct"], requestId: "req-web-0001" }],
      ],
      decideHanded: [
        { opportunity: "opp_01J9ZZZZZZZZZZZZZZZZZZZZZT", answer: "dismiss", reason: "wrong_timing", ...r },
        "cards.decideHanded",
        [{ opportunity: "opp_01J9ZZZZZZZZZZZZZZZZZZZZZT", answer: "dismiss", reason: "wrong_timing", ...r }],
      ],
      judgeResult: [
        { move: "mov_01J9ZZZZZZZZZZZZZZZZZZZZZT", answer: "not_useful", ...r },
        "cards.judgeResult",
        [{ move: "mov_01J9ZZZZZZZZZZZZZZZZZZZZZT", answer: "not_useful", ...r }],
      ],
      vetoTime: [
        { proposal: "tpr_01J9ZZZZZZZZZZZZZZZZZZZZZT", ...r },
        "time.veto",
        [{ proposal: "tpr_01J9ZZZZZZZZZZZZZZZZZZZZZT", ...r }],
      ],
      closeCommitment: [{ fact: FACT, ending: "done", ...r }, "commitments.closeCommitment", [FACT, "done", r]],
      reopenCommitment: [{ fact: FACT, ...r }, "commitments.reopenCommitment", [FACT, r]],
      closeOpenItem: [
        { source: "plan", key: FACT, ending: "done", ...r },
        "openItems.close",
        [{ source: "plan", key: FACT, ending: "done" }, r],
      ],
      reopenOpenItem: [{ key: FACT, ...r }, "openItems.reopen", [FACT, r]],
      addGoal: [
        { statement: SENTINEL_TEXT, domain: "career", ...r },
        "work.addGoal",
        [SENTINEL_TEXT, "own", { ...r, domain: "career" }],
      ],
      setGoalStatus: [{ goal: GOAL, status: "done", ...r }, "work.setGoalStatus", [GOAL, "done", r]],
      setGoalTarget: [{ goal: GOAL, entity: null, ...r }, "work.setGoalTarget", [GOAL, null, r]],
      editGoal: [{ goal: GOAL, statement: SENTINEL_TEXT, ...r }, "work.editGoal", [GOAL, SENTINEL_TEXT, r]],
      rankGoal: [{ goal: GOAL, after: null, ...r }, "work.rankGoal", [GOAL, null, r]],
      adoptGoal: [
        { fact: "a".repeat(64), change: { statement: SENTINEL_TEXT }, ...r },
        "work.adoptGoal",
        ["a".repeat(64), { statement: SENTINEL_TEXT }, r],
      ],
      unadoptGoal: [{ goal: GOAL, ...r }, "work.unadoptGoal", [GOAL, r]],
      hideGoal: [{ fact: "a".repeat(64), ...r }, "work.hideGoal", ["a".repeat(64), r]],
      unhideGoal: [{ fact: "a".repeat(64), ...r }, "work.unhideGoal", ["a".repeat(64), r]],
      setTier: [{ person: ENTITY, tier: "close", ...r }, "tiers.setTier", [ENTITY, "close", r]],
      clearTier: [{ person: ENTITY, ...r }, "tiers.clearTier", [ENTITY, r]],
      samePerson: [{ a: ENTITY, b: OTHER_ENTITY, ...r }, "identity.linkPeople", [ENTITY, OTHER_ENTITY, "same", r]],
      differentPeople: [
        { a: ENTITY, b: OTHER_ENTITY, ...r },
        "identity.linkPeople",
        [ENTITY, OTHER_ENTITY, "different", r],
      ],
      liftIdentity: [{ ruling: RULING, ...r }, "identity.liftIdentity", [RULING, r]],
      liftFactRuling: [{ ruling: RULING, ...r }, "facts.liftFactRuling", [RULING, r]],
      ignorePerson: [{ person: ENTITY, ...r }, "ignores.addIgnore", ["entity", ENTITY, r]],
      liftIgnore: [{ ruling: RULING, ...r }, "ignores.liftIgnore", [RULING, r]],
      setLearning: [
        { client: "alpha", on: false, ...r },
        "releases.setLearning",
        [{ client: "alpha", on: false, ...r }],
      ],
      liftVeto: [{ ruling: RULING, ...r }, "cards.liftVeto", [RULING, r]],
      retireFact: [{ fact: FACT, ...r }, "facts.retireFact", [FACT, r]],
      rejectClaim: [{ fact: FACT, ...r }, "facts.rejectClaim", [FACT, r]],
      vetoFact: [{ fact: FACT, ...r }, "facts.vetoFact", [FACT, r]],
      liftRuling: [{ ruling: RULING, ...r }, "facts.liftRuling", [RULING, r]],
      factDomain: [{ fact: FACT, domain: "health", ...r }, "facts.reclassifyFact", [FACT, "domain", "health", r]],
      factKind: [{ fact: FACT, kind: "need", ...r }, "facts.reclassifyFact", [FACT, "kind", "need", r]],
      nameOrganization: [
        { organization: ENTITY, name: "Example Org", ...r },
        "identity.nameOrganization",
        [ENTITY, "Example Org", r],
      ],
      namePerson: [{ person: ENTITY, name: SENTINEL_TEXT, ...r }, "identity.namePerson", [ENTITY, SENTINEL_TEXT, r]],
      liftPersonName: [{ ruling: RULING, ...r }, "identity.liftPersonName", [RULING, r]],
      addTask: [
        { role: "research", kind: "research", about: [], note: SENTINEL_TEXT, ...r },
        "work.addTask",
        [{ role: "research", kind: "research", about: [], note: SENTINEL_TEXT, ...r }],
      ],
      withdrawTask: [
        { task: "opp_01J9ZZZZZZZZZZZZZZZZZZZZZT", ...r },
        "work.withdrawTask",
        [{ task: "opp_01J9ZZZZZZZZZZZZZZZZZZZZZT", ...r }],
      ],
      addNote: [
        { person: ENTITY, role: "bio", text: SENTINEL_TEXT, ...r },
        "notes.addNote",
        [{ person: ENTITY, role: "bio", text: SENTINEL_TEXT }, r],
      ],
      retireNote: [{ note: FACT, ...r }, "notes.retireNote", [FACT, r]],
      correctValue: [
        { fact: FACT, value: { title: SENTINEL_TEXT }, ...r },
        "notes.correctValue",
        [FACT, { title: SENTINEL_TEXT }, r],
      ],
      createList: [{ name: SENTINEL_TEXT, ...r }, "lists.createList", [SENTINEL_TEXT, r]],
      renameList: [{ list: LIST, name: SENTINEL_TEXT, ...r }, "lists.renameList", [LIST, SENTINEL_TEXT, r]],
      deleteList: [{ list: LIST, ...r }, "lists.deleteList", [LIST, r]],
      addToList: [{ list: LIST, person: ENTITY, ...r }, "lists.addToList", [LIST, ENTITY, r]],
      removeFromList: [{ list: LIST, person: ENTITY, ...r }, "lists.removeFromList", [LIST, ENTITY, r]],
      // The brake: the state is the route's, the body the request alone.
      stopWork: [{ ...r }, "work.setKillSwitch", ["on", r]],
      // A relayed answer taken back: the card, and the request, which a repeat is answered by.
      reopenRelayed: [{ card: CARD, ...r }, "cards.reopenRelayed", [CARD, r]],
      // The owner's mark on an agent's settlement: the card and the mark.
      markAgentSettlement: [{ card: CARD, mark: "wrong", ...r }, "cards.markSettled", [CARD, "wrong"]],
      // The owner's veto of a learning: the learning alone.
      retireLearning: [{ learning: LEARNING, ...r }, "work.retireLearning", [LEARNING]],
      // The owner's mark on an agent's anchor or ruling: the row and the mark.
      markAgentTime: [
        { id: "atr_01J9ZZZZZZZZZZZZZZZZZZZZZT", mark: "wrong", ...r },
        "time.markAgent",
        ["atr_01J9ZZZZZZZZZZZZZZZZZZZZZT", "wrong"],
      ],
      // The owner's mark on a sampled check of what dreaming found.
      markDreamCheck: [
        { check: "42", mark: "right", newToMe: true, ...r },
        "extraction.markDreamCheck",
        ["42", "right", true],
      ],
    };
    for (const [name, [body, method, args]] of Object.entries(bodies)) {
      const answer = await post(name, JSON.parse(JSON.stringify(body)));
      expect(answer.status, `${name}: ${answer.body}`).toBe(200);
      expect(s.fake.calls.at(-1), name).toEqual([method, args]);
    }
    expect(s.fake.calls).toHaveLength(Object.keys(WRITES).length);
    // A fixed argument in the body, two cards, or a write's arguments in a GET are refused.
    for (const [name, body] of [
      ["samePerson", { a: ENTITY, b: OTHER_ENTITY, verdict: "different", ...r }],
      ["ignorePerson", { person: ENTITY, target: "domain", ...r }],
      ["factDomain", { fact: FACT, domain: "health", verdict: "kind", ...r }],
      ["factKind", { fact: FACT, kind: "need", verdict: "domain", ...r }],
      ["factKind", { fact: FACT, kind: "preference", ...r }],
      ["decide", { cards: [CARD, OTHER], answer: "acknowledge", ...r }],
      ["decide", decideBody({ card: [CARD, OTHER] })],
      ["decide", decideBody({ batch: true })],
      ["stopWork", { state: "off", ...r }],
    ] as const) {
      expect(await post(name, body), `${name} ${JSON.stringify(body)}`).toMatchObject({
        status: 400,
        body: '{"refused":"usage"}',
      });
    }
    expect((await ask(s.socket, `/api/decide?card=${CARD}&answer=acknowledge`, { cookie })).status).toBe(405);
    expect(s.fake.calls).toHaveLength(Object.keys(WRITES).length);
    // Logs: ids and codes, never the body's words.
    expect(s.logged).toContainEqual({ event: "web_written", code: "decide", ids: { card: CARD } });
    expect(s.logged).toContainEqual({ event: "web_written", code: "add_goal" });
    expect(JSON.stringify(s.logged)).not.toContain(SENTINEL_TEXT);
    expect(JSON.stringify(s.logged)).not.toContain(token);
  });

  it("the Admin's refusal is answered by its code", async () => {
    const s = await started();
    const cookie = await login(s);
    const token = await tokenOf(s, cookie);
    for (const [code, status] of [
      ["not_pending", 409],
      ["not_built", 409],
      ["not_found", 404],
      ["invalid_argument", 400],
    ] as const) {
      s.fake.answers["cards.decide"] = () => {
        throw new AdminError(code);
      };
      const refused = await ask(s.socket, "/api/decide", {
        cookie,
        token,
        origin: `http://${LOCAL}`,
        json: decideBody(),
      });
      expect(refused, code).toMatchObject({ status, body: JSON.stringify({ refused: code }) });
      expect(s.logged.at(-1)).toEqual({ event: "web_refused", code, ids: { card: CARD } });
    }
    // The rulings in force come with the refusal, as the command prints them.
    s.fake.answers["tiers.setTier"] = () => {
      throw new AdminError("already_settled", undefined, [RULING]);
    };
    const settled = await ask(s.socket, "/api/setTier", {
      cookie,
      token,
      origin: `http://${LOCAL}`,
      json: { person: ENTITY, tier: "close", requestId: "req-web-0004" },
    });
    expect(settled).toMatchObject({
      status: 409,
      body: JSON.stringify({ refused: "already_settled", rulings: [RULING] }),
    });
    // A lift that found nothing in force wrote nothing: not_found, as `pi correct lift` says.
    s.fake.answers["facts.liftRuling"] = () => false;
    const lifted = await ask(s.socket, "/api/liftRuling", {
      cookie,
      token,
      origin: `http://${LOCAL}`,
      json: { ruling: RULING, requestId: "req-web-0005" },
    });
    expect(lifted).toMatchObject({ status: 404, body: '{"refused":"not_found"}' });
    expect(s.logged.at(-1)).toEqual({ event: "web_refused", code: "not_found" });
  });

  it("after each write, written or refused, and before the answer, the after-write step runs; never after a read", async () => {
    const order: string[] = [];
    const s = await started({
      afterWrite: async () => {
        order.push("afterWrite");
      },
    });
    const cookie = await login(s);
    const token = await tokenOf(s, cookie);
    const post = async (name: string, json: unknown) => {
      const answer = await ask(s.socket, `/api/${name}`, { cookie, token, origin: `http://${LOCAL}`, json });
      order.push(`${name} ${answer.status}`);
    };
    // A lift of a release appends to the erasure journal as pi.
    await post("liftRuling", { ruling: RULING, requestId: "req-web-0006" });
    // A transaction that died after its journal line: the step runs all the same.
    s.fake.answers["commitments.reopenCommitment"] = () => {
      throw new AdminError("not_closed");
    };
    await post("reopenCommitment", { fact: FACT, requestId: "req-web-0007" });
    await ask(s.socket, "/api/digest", { cookie });
    expect(order).toEqual(["afterWrite", "liftRuling 200", "afterWrite", "reopenCommitment 409"]);
  });

  it("a write's answer does not wait on the after-write step, even one that never ends", async () => {
    let runs = 0;
    const s = await started({
      afterWrite: () => {
        runs += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const cookie = await login(s);
    const token = await tokenOf(s, cookie);
    const answer = await ask(s.socket, "/api/liftRuling", {
      cookie,
      token,
      origin: `http://${LOCAL}`,
      json: { ruling: RULING, requestId: "req-web-0008" },
    });
    expect(answer.status).toBe(200);
    expect(runs).toBe(1);
  });

  it("B5: a read the Admin refuses answers its code; an audience mid-rebuild is 409 rebuilding", async () => {
    const s = await started();
    const cookie = await login(s);
    for (const [code, status] of [
      ["rebuilding", 409],
      ["invalid_argument", 400],
      ["not_found", 404],
    ] as const) {
      s.fake.answers["people.network"] = () => {
        throw new AdminError(code);
      };
      expect(await ask(s.socket, "/api/network?tiers=inner,close&limit=20", { cookie }), code).toMatchObject({
        status,
        body: JSON.stringify({ refused: code }),
      });
      expect(s.logged.at(-1)).toEqual({ event: "web_refused", code });
    }
    expect(s.fake.calls.at(-1)).toEqual(["people.network", [{ tiers: ["inner", "close"], limit: 20 }]]);
    // The people reads take their ids and cursor from the query.
    s.fake.answers["people.timeline"] = () => ({ month: "2026-10", entries: [], next: null });
    expect(JSON.parse((await ask(s.socket, `/api/timeline?entity=${ENTITY}&limit=5`, { cookie })).body)).toEqual({
      month: "2026-10",
      entries: [],
      next: null,
    });
    expect(s.fake.calls.at(-1)).toEqual(["people.timeline", [{ entity: ENTITY, limit: 5 }]]);
    s.fake.answers["people.paths"] = () => null;
    expect(await ask(s.socket, `/api/paths?target=${ENTITY}`, { cookie })).toMatchObject({ status: 404 });
    expect(s.fake.calls.at(-1)).toEqual(["people.paths", [ENTITY, undefined]]);
  });

  it("B6: search is POST /api/search with the term in the body, checked as a write is, and the term reaches no log line", async () => {
    const TERM = "sentinel-search-term-7c2e";
    const HITS = {
      hits: [
        {
          who: { id: ENTITY, kind: "person", name: { untrusted: "Example Person" }, address: null },
          tier: "close",
          match: "name",
        },
      ],
    };
    const fake = fakeAdmin();
    fake.answers["search.entities"] = () => HITS;
    const s = await started({ fake });
    const cookie = await login(s);
    const token = await tokenOf(s, cookie);
    const search = (extra: Asked = {}) =>
      ask(s.socket, "/api/search", { cookie, token, origin: `http://${LOCAL}`, json: { term: TERM }, ...extra });
    expect(JSON.parse((await search()).body)).toEqual(HITS);
    expect(s.fake.calls).toEqual([["search.entities", [TERM]]]);
    // Never in a URL: a GET reads nothing, the term in its query or not.
    for (const path of ["/api/search", `/api/search?term=${TERM}`])
      expect((await ask(s.socket, path, { cookie })).status, path).toBe(405);
    // From another Origin, or without the token: 403. A body not of the shape: usage.
    expect((await search({ origin: "http://evil.example" })).status).toBe(403);
    expect(
      (await ask(s.socket, "/api/search", { cookie, origin: `http://${LOCAL}`, json: { term: TERM } })).status,
    ).toBe(403);
    for (const json of [{}, { term: "" }, { term: "x".repeat(101) }, { term: TERM, extra: 1 }])
      expect(await search({ json }), JSON.stringify(json)).toMatchObject({ status: 400, body: '{"refused":"usage"}' });
    expect(s.fake.calls).toHaveLength(1);
    // A result not of the shape is never served, and its log line names the read only.
    fake.answers["search.entities"] = () => ({ hits: [], term: TERM });
    expect(await search()).toMatchObject({ status: 500, body: '{"refused":"unavailable"}' });
    expect(s.logged).toContainEqual({ event: "web_bad_result", code: "search" });
    expect(JSON.stringify(s.logged)).not.toContain(TERM);
  });

  it("a mixed-case Host still takes its lowercase Origin", async () => {
    const s = await started();
    const cookie = await login(s);
    const token = await tokenOf(s, cookie);
    expect(
      (
        await ask(s.socket, "/api/decide", {
          host: "LocalHost:8765",
          cookie,
          token,
          origin: `http://${LOCAL}`,
          json: decideBody(),
        })
      ).status,
    ).toBe(200);
  });

  it("W3: anything the Never in a browser list names answers not_here, by route or forged", async () => {
    const s = await started();
    const cookie = await login(s);
    const token = await tokenOf(s, cookie);
    // Each entry as a route might be named, and routes no registry holds.
    const camel = (command: string): string =>
      command.replace(" *", "").replace(/[ -]([a-z])/g, (_, one: string) => one.toUpperCase());
    const names = [
      ...NEVER_IN_A_BROWSER.map((entry) => camel(entry.command)),
      "erasePerson",
      "sendDraft",
      "ignoreDomain",
      "decideBatch",
      "web",
      "webLink",
      "",
      "decide/x",
    ];
    for (const name of names) {
      expect(Object.hasOwn(READS, name) || Object.hasOwn(WRITES, name), name).toBe(false);
      for (const method of ["GET", "POST"]) {
        expect(
          await ask(s.socket, `/api/${name}`, {
            method,
            cookie,
            token,
            origin: `http://${LOCAL}`,
            ...(method === "POST" ? { json: { requestId: "req-web-0003" } } : {}),
          }),
          `${method} ${name}`,
        ).toMatchObject({ status: 404, body: '{"refused":"not_here"}' });
      }
    }
    expect(NEVER_IN_A_BROWSER.some((entry) => covers(entry, "web link"))).toBe(true);
    expect(s.fake.calls).toEqual([]);
  });
});

describe("A5: the phone's passkey", () => {
  const headers = { "tailscale-user-login": TS.login };
  const origin = `https://${TS.host}`;
  type Post = { cookie?: string; headers?: Record<string, string>; origin?: string };
  const post = (s: Started, path: string, json: unknown, options: Post = {}): Promise<Answer> =>
    ask(s.socket, path, {
      host: TS.host,
      headers: options.headers ?? headers,
      origin: options.origin ?? origin,
      json,
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    });
  const cookieOf = (answer: Answer): string => {
    const cookie = [answer.headers["set-cookie"] ?? []].flat()[0] ?? "";
    expect(cookie).toMatch(/^pi_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Secure$/);
    return cookie.split(";")[0] ?? "";
  };
  const challengeOf = (answer: Answer): string => (JSON.parse(answer.body) as { challenge: string }).challenge;

  // Registers a device with a code from the control socket: the passkey session's cookie.
  async function register(s: Started, device: Authenticator): Promise<string> {
    const code = await control(s.socket, "register");
    const options = await post(s, "/passkey/register-options", { code });
    expect(options.status).toBe(200);
    expect(JSON.parse(options.body)).toMatchObject({
      rp: { id: TS.host },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      attestation: "none",
      authenticatorSelection: { userVerification: "required" },
    });
    const answer = await post(s, "/passkey/register", { code, ...registration(device, TS.host, challengeOf(options)) });
    expect(answer.status).toBe(200);
    return cookieOf(answer);
  }
  async function signIn(
    s: Started,
    device: Authenticator,
    options: Parameters<typeof assertion>[3] = {},
  ): Promise<Answer> {
    const offered = await post(s, "/passkey/login-options", {});
    expect(offered.status).toBe(200);
    expect(JSON.parse(offered.body)).toMatchObject({
      rpId: TS.host,
      allowCredentials: [{ type: "public-key", id: device.id.toString("base64url") }],
      userVerification: "required",
    });
    return post(s, "/passkey/login", assertion(device, TS.host, challengeOf(offered), options));
  }

  it("a code from the control socket registers the phone's passkey once, kept 0600 beside the key file, and signs it in with a Secure cookie", async () => {
    const s = await started({ tailscale: TS });
    const device = authenticator();
    const cookie = await register(s, device);
    expect((await ask(s.socket, "/api/digest", { host: TS.host, headers, cookie })).status).toBe(200);
    const file = `${s.socket}-passkey`;
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      id: device.id.toString("base64url"),
      publicKey: device.spki.toString("base64url"),
      signCount: 0,
    });
    // A code is spent by its registration: it opens no second ceremony.
    const code = await control(s.socket, "register");
    const options = await post(s, "/passkey/register-options", { code });
    expect(
      (await post(s, "/passkey/register", { code, ...registration(device, TS.host, challengeOf(options)) })).status,
    ).toBe(200);
    expect(await post(s, "/passkey/register-options", { code })).toMatchObject({ status: 401, body: "" });
    // A login code is not a registration code, nor the reverse.
    const linkCode = await control(s.socket, "link");
    expect(await post(s, "/passkey/register-options", { code: linkCode })).toMatchObject({ status: 401, body: "" });
    const registerCode = await control(s.socket, "register");
    expect(await ask(s.socket, `/login?code=${registerCode}`, { host: TS.host, headers })).toMatchObject({
      status: 401,
      body: REFUSED_LINK,
    });
    // A restart keeps the passkey.
    await s.web.close();
    const again = await started({ tailscale: TS, socket: s.socket });
    expect((await signIn(again, device)).status).toBe(200);
    for (const word of [code, linkCode, registerCode])
      expect(JSON.stringify([...s.logged, ...again.logged])).not.toContain(word);
  });

  it("a registration without the code, or with a forged response, is refused and stores nothing", async () => {
    const s = await started({ tailscale: TS });
    const device = authenticator();
    expect(await post(s, "/passkey/register-options", { code: "A".repeat(43) })).toMatchObject({
      status: 401,
      body: "",
    });
    const code = await control(s.socket, "register");
    const options = await post(s, "/passkey/register-options", { code });
    // Another origin's response, then the same challenge again, used once already.
    expect(
      await post(s, "/passkey/register", {
        code,
        ...registration(device, TS.host, challengeOf(options), { origin: "https://evil.example" }),
      }),
    ).toMatchObject({ status: 401, body: "" });
    expect(
      await post(s, "/passkey/register", { code, ...registration(device, TS.host, challengeOf(options)) }),
    ).toMatchObject({ status: 401, body: "" });
    // The code lapses after 5 minutes.
    const fresh = await post(s, "/passkey/register-options", { code });
    s.clock.now = new Date(T0.getTime() + 5 * MINUTE + 1);
    expect(
      await post(s, "/passkey/register", { code, ...registration(device, TS.host, challengeOf(fresh)) }),
    ).toMatchObject({ status: 401, body: "" });
    expect(existsSync(`${s.socket}-passkey`)).toBe(false);
    expect(await post(s, "/passkey/login-options", {})).toMatchObject({
      status: 404,
      body: '{"refused":"no_passkey"}',
    });
  });

  it("a forged assertion is refused: a wrong challenge, origin or signature, or a falling sign count", async () => {
    const s = await started({ tailscale: TS });
    const device = authenticator();
    await register(s, device);
    expect((await signIn(s, device, { count: 5 })).status).toBe(200);
    const forged: Parameters<typeof assertion>[3][] = [
      { count: 6, origin: "https://evil.example" },
      { count: 6, signer: authenticator().privateKey },
      { count: 4 },
      { count: 5 },
    ];
    for (const options of forged)
      expect(await signIn(s, device, options), JSON.stringify(options)).toMatchObject({ status: 401, body: "" });
    // A challenge the server never issued, and one already used.
    const offered = await post(s, "/passkey/login-options", {});
    expect(await post(s, "/passkey/login", assertion(device, TS.host, "A".repeat(43), { count: 6 }))).toMatchObject({
      status: 401,
      body: "",
    });
    expect(
      await post(s, "/passkey/login", assertion(device, TS.host, challengeOf(offered), { count: 6 })),
    ).toMatchObject({ status: 401, body: "" });
    // The positive control, and the count kept.
    const answer = await signIn(s, device, { count: 6 });
    expect(answer.status).toBe(200);
    expect(JSON.parse(readFileSync(`${s.socket}-passkey`, "utf8"))).toMatchObject({ signCount: 6 });
    expect((await ask(s.socket, "/api/digest", { host: TS.host, headers, cookie: cookieOf(answer) })).status).toBe(200);
    expect(s.logged.filter((one) => one.event === "web_refused").map((one) => one.code)).toEqual(
      Array(6).fill("passkey_refused"),
    );
  });

  it("the ceremonies are POSTs from the https ts.net origin, carrying the owner's Tailscale login, and exist on no other Host", async () => {
    const s = await started({ tailscale: TS });
    for (const path of ["/passkey/register-options", "/passkey/register", "/passkey/login-options", "/passkey/login"]) {
      expect(await ask(s.socket, path, { host: TS.host, headers }), path).toMatchObject({ status: 405, body: "" });
      for (const bad of [undefined, `http://${TS.host}`, "https://evil.example", "null"]) {
        expect(
          await ask(s.socket, path, {
            host: TS.host,
            headers,
            json: {},
            ...(bad === undefined ? {} : { origin: bad }),
          }),
          `${path} ${bad}`,
        ).toMatchObject({ status: 403, body: "" });
      }
      for (const header of [{}, { "tailscale-user-login": "someone@example.com" }])
        expect(await post(s, path, {}, { headers: header }), path).toMatchObject({ status: 403, body: "" });
      expect(await post(s, path, [])).toMatchObject({ status: 400 });
    }
    const local = await started();
    expect(await control(local.socket, "register")).toBe("usage");
    for (const path of ["/passkey/register-options", "/passkey/login-options"])
      expect(await ask(local.socket, path, { origin: `http://${LOCAL}`, json: {} }), path).toMatchObject({
        status: 404,
        body: "",
      });
    expect(s.fake.calls).toEqual([]);
  });

  it("a new registration replaces the last passkey at once, and a file that is not a passkey leaves the link working", async () => {
    const s = await started({ tailscale: TS });
    const lost = authenticator();
    const lostCookie = await register(s, lost);
    const offered = await post(s, "/passkey/login-options", {});
    const found = authenticator();
    const foundCookie = await register(s, found);
    expect(await ask(s.socket, "/api/digest", { host: TS.host, headers, cookie: lostCookie })).toMatchObject({
      status: 401,
      body: "",
    });
    expect((await ask(s.socket, "/api/digest", { host: TS.host, headers, cookie: foundCookie })).status).toBe(200);
    expect(await post(s, "/passkey/login", assertion(lost, TS.host, challengeOf(offered)))).toMatchObject({
      status: 401,
      body: "",
    });
    expect(await signIn(s, found)).toMatchObject({ status: 200 });
    // A broken file: no passkey, its code logged, and the Mac's link still logs in.
    await s.web.close();
    await writeFile(`${s.socket}-passkey`, "{");
    const again = await started({ tailscale: TS, socket: s.socket });
    expect(again.logged).toContainEqual({ event: "web_passkey_unread", code: "bad_passkey_file" });
    expect(await post(again, "/passkey/login-options", {})).toMatchObject({
      status: 404,
      body: '{"refused":"no_passkey"}',
    });
    await login(again, TS.host);
  });

  it("a passkey session idles out after 10 minutes, and one per device: it leaves the link's session alone", async () => {
    const s = await started({ tailscale: TS });
    const device = authenticator();
    const phone = await register(s, device);
    const mac = await login(s, TS.host);
    s.clock.now = new Date(T0.getTime() + 9 * MINUTE);
    expect((await ask(s.socket, "/", { host: TS.host, headers, cookie: phone })).status).toBe(200);
    s.clock.now = new Date(T0.getTime() + 19 * MINUTE + 1);
    expect(await ask(s.socket, "/api/digest", { host: TS.host, headers, cookie: phone })).toMatchObject({
      status: 401,
      body: "",
    });
    expect((await ask(s.socket, "/api/digest", { host: TS.host, headers, cookie: mac })).status).toBe(200);
    // A new sign-in ends the last passkey session.
    const first = await signIn(s, device);
    const second = await signIn(s, device);
    expect(await ask(s.socket, "/api/digest", { host: TS.host, headers, cookie: cookieOf(first) })).toMatchObject({
      status: 401,
      body: "",
    });
    expect((await ask(s.socket, "/api/digest", { host: TS.host, headers, cookie: cookieOf(second) })).status).toBe(200);
  });

  it("pi web link --register prints a registration link at the ts.net name only, to a terminal only", async () => {
    const keyFile = join(await folder(), "keys.json");
    const s = await started({ socket: `${keyFile}.web`, tailscale: TS });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const sink = (into: Buffer[]) =>
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          into.push(chunk);
          done();
        },
      });
    const env = { PI_DATABASE_URL_ADMIN: "postgres://pi_admin:sentinel@127.0.0.1:1/pi_test", PI_KEY_FILE: keyFile };
    const io = (tty: boolean) => ({ stdout: sink(out), stderr: sink(err), stdin: Readable.from([]), stdoutIsTTY: tty });
    const ts = { ...env, PI_WEB_TS_HOST: TS.host, PI_WEB_TS_LOGIN: TS.login };
    expect(await run(["web", "link", "--register"], ts, io(false))).toBe(1);
    // A usage refusal exits 2.
    expect(await run(["web", "link", "--register"], env, io(true))).toBe(2);
    expect(Buffer.concat(err).toString("utf8")).toContain('"code":"usage"');
    expect(Buffer.concat(out).toString("utf8")).toBe("");
    expect(await run(["web", "link", "--register"], ts, io(true))).toBe(0);
    const printed = Buffer.concat(out).toString("utf8");
    expect(printed).toMatch(/^https:\/\/box\.tail1234\.ts\.net\/register\?code=[A-Za-z0-9_-]{43}\n$/);
    const code = new URL(printed.trim()).searchParams.get("code");
    expect((await post(s, "/passkey/register-options", { code })).status).toBe(200);
  });
});

// One open event stream: its status and headers, each event as it comes, and `close` to leave.
type Stream = {
  status: number;
  headers: Answer["headers"];
  events: { id: string; data: LedgerEvent }[];
  next(count: number): Promise<void>;
  ended: Promise<void>;
  close(): void;
};

function openStream(
  socket: string,
  path: string,
  cookie: string,
  headers: Record<string, string> = {},
): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const sent = request(
      { socketPath: socket, path, headers: { host: LOCAL, cookie, ...headers }, setHost: false },
      (response) => {
        const events: Stream["events"] = [];
        let waiting: { count: number; done: () => void }[] = [];
        let text = "";
        let finish: () => void = () => {};
        const ended = new Promise<void>((done) => (finish = done));
        response.setEncoding("utf8").on("data", (chunk: string) => {
          text += chunk;
          let end = text.indexOf("\n\n");
          while (end !== -1) {
            const block = text.slice(0, end);
            text = text.slice(end + 2);
            end = text.indexOf("\n\n");
            const fields = Object.fromEntries(
              block
                .split("\n")
                .filter((line) => !line.startsWith(":"))
                .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
            );
            if (fields.event === "ledger")
              events.push({ id: fields.id ?? "", data: JSON.parse(fields.data ?? "null") as LedgerEvent });
          }
          const due = waiting.filter((wait) => events.length >= wait.count);
          waiting = waiting.filter((wait) => events.length < wait.count);
          for (const wait of due) wait.done();
        });
        response.on("close", () => finish());
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          events,
          next: (count) => new Promise((done) => (events.length >= count ? done() : waiting.push({ count, done }))),
          ended,
          close: () => sent.destroy(),
        });
      },
    );
    sent.on("error", (error: NodeJS.ErrnoException) => (error.code === "ECONNRESET" ? undefined : reject(error)));
    sent.end();
  });
}

const ledgerEvent = (id: number): LedgerEvent => ({
  id,
  at: T0.toISOString(),
  row: { kind: "card", id: CARD },
  event: "pending",
  code: null,
  by: "system:test",
  work: null,
});

describe("B7: the event stream", () => {
  it("sends each poll's events as server-sent events, carrying the cursor from poll to poll, with the stream's high mark as each id", async () => {
    const fake = fakeAdmin();
    const polls: unknown[] = [];
    const answers = [
      { events: [ledgerEvent(5)], cursor: { after: 5, delivered: [5] } },
      { events: [ledgerEvent(9), ledgerEvent(4)], cursor: { after: 9, delivered: [4, 5, 9] } },
    ];
    fake.answers["ledger.events"] = (cursor: unknown) => {
      polls.push(cursor);
      return answers[polls.length - 1] ?? { events: [], cursor: { after: 9, delivered: [] } };
    };
    const s = await started({ fake, eventsMs: 5 });
    const cookie = await login(s);
    const stream = await openStream(s.socket, "/api/events?after=3", cookie);
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(stream.headers["content-security-policy"]).toBe(WEB_HEADERS["Content-Security-Policy"]);
    expect(stream.headers["cache-control"]).toBe("no-store");
    await stream.next(3);
    stream.close();
    expect(stream.events).toEqual([
      { id: "5", data: ledgerEvent(5) },
      { id: "9", data: ledgerEvent(9) },
      { id: "9", data: ledgerEvent(4) },
    ]);
    expect(polls.slice(0, 2)).toEqual([{ after: 3, delivered: [] }, answers[0]?.cursor]);
  });

  it("resumes after a browser's Last-Event-ID when it is higher, and refuses arguments not of its shape", async () => {
    const fake = fakeAdmin();
    const polls: unknown[] = [];
    fake.answers["ledger.events"] = (cursor: { after: number }) => {
      polls.push(cursor);
      return { events: [], cursor: { after: cursor.after, delivered: [] } };
    };
    const s = await started({ fake, eventsMs: 60_000 });
    const cookie = await login(s);
    const stream = await openStream(s.socket, "/api/events?after=3", cookie, { "last-event-id": "12" });
    stream.close();
    expect(polls[0]).toEqual({ after: 12, delivered: [] });
    for (const path of [
      "/api/events",
      "/api/events?after=x",
      "/api/events?after=1&after=2",
      "/api/events?after=1&extra=1",
    ]) {
      expect(await ask(s.socket, path, { cookie }), path).toMatchObject({ status: 400, body: '{"refused":"usage"}' });
    }
    expect(
      (await ask(s.socket, "/api/events?after=1", { cookie, method: "POST", origin: `http://${LOCAL}` })).status,
    ).toBe(405);
    expect(await ask(s.socket, "/api/events?after=1")).toMatchObject({ status: 401, body: "" });
    expect(Object.keys(STREAMS)).toEqual(["events"]);
    expect(polls).toHaveLength(1);
  });

  it("is never the owner's action: it keeps no session alive, and ends when the session does", async () => {
    const fake = fakeAdmin();
    let polls = 0;
    fake.answers["ledger.events"] = () => {
      polls += 1;
      return { events: [], cursor: { after: 0, delivered: [] } };
    };
    const s = await started({ fake, eventsMs: 5 });
    const cookie = await login(s);
    const stream = await openStream(s.socket, "/api/events?after=0", cookie);
    s.clock.now = new Date(T0.getTime() + 30 * MINUTE + 1);
    await stream.ended;
    expect(polls).toBeGreaterThanOrEqual(1);
    const after = polls;
    expect(await ask(s.socket, "/api/digest", { cookie })).toMatchObject({ status: 401, body: "" });
    expect(polls).toBe(after);
  });

  it("ends when a poll fails, logging its code only", async () => {
    const fake = fakeAdmin();
    fake.answers["ledger.events"] = () => {
      throw new Error("canary-poll-failure");
    };
    const s = await started({ fake, eventsMs: 5 });
    const stream = await openStream(s.socket, "/api/events?after=0", await login(s));
    await stream.ended;
    // An error no code expects is a bug, by its class.
    expect(s.logged).toContainEqual({ event: "web_failed", code: "bug", reason: "error" });
    expect(JSON.stringify(s.logged)).not.toContain("canary-poll-failure");
  });
});
