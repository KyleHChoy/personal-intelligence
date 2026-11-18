import { lstat, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection, createServer as createSocketServer, type Server } from "node:net";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import { systemNow } from "@intelligence/personal-core";
import type { Admin } from "@intelligence/personal-store";
import { codeOf, type Env, refusal } from "../env.ts";
import { faultFields } from "../logger.ts";
import { json } from "./web-answer.ts";
import { createCeremonies } from "./web-ceremony.ts";
import type { Client } from "./web-client.ts";
import type { Tailscale } from "./web-guards.ts";
import type { RestrictedLock } from "./web-restricted.ts";
import { createRouter } from "./web-router.ts";
import { createSessions } from "./web-sessions.ts";

export type { Tailscale } from "./web-guards.ts";
export { TOKEN } from "./web-sessions.ts";

// The owner's dashboard's server. `pi web serve` runs supervised as `pi`, with no terminal and no lifetime
// of its own, and serves on two Unix sockets beside the key file, never a TCP port: the page's,
// `<PI_KEY_FILE>.web`, and the control socket, `<PI_KEY_FILE>.web-control`, mode 0600, on which `pi web
// link` asks for a login code (or, with `--register`, a code to register the phone's passkey) and `pi web
// stop` ends it. The page's socket is 0660 in the process's primary group, `piweb` on the box, through
// which `tailscale serve` reaches it. It serves the client's files and the registry's reads and writes
// (web-routes.ts) as JSON, one owner decision per write. It logs ids, counts and codes only; a login code
// goes to the terminal of `pi web link` alone. This file composes the server; its parts are the answers
// (web-answer.ts), the codes and sessions (web-sessions.ts), the passkey's ceremonies (web-ceremony.ts),
// the request checks (web-guards.ts) and the routing (web-router.ts).

const EVENTS_MS = 5_000;
const NAME_HOLDS_MS = 5 * 60_000;
// The agent's process cannot run a card's effect; this one, the owner's, does, through the page's
// own answer path.
const RELAYS_MS = 30_000;

const TS_HOST = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*\.ts\.net$/;
const TS_LOGIN = /^[^\s\p{Cc}]{1,254}$/u;

export type WebOptions = {
  // `<PI_KEY_FILE>.web`; the control socket is the same path with `-control`.
  socket: string;
  admin: Admin;
  log: PersonalLogger;
  client: Client;
  // The node's `ts.net` name and the owner's Tailscale login.
  tailscale?: Tailscale;
  now?: () => Date;
  // The event stream's poll interval; 5 seconds unless a test sets it.
  eventsMs?: number;
  // The name holds' sweep interval; five minutes unless a test sets it, 0 for none.
  nameHoldsMs?: number;
  // The relayed answers' interval; thirty seconds unless a test sets it, 0 for none.
  relaysMs?: number;
  // The host's PI_DRIVE_STORAGE_CEILING_BYTES, for the `status` read; Drive's default when unset.
  driveCeilingBytes?: number;
  // Started once each write's transaction is over, whatever its end, before the answer, and never
  // awaited, so the answer waits on nothing it does; never throws.
  afterWrite?: () => Promise<void>;
  // The wrapped restricted key file and the unlock this process holds (web-restricted.ts), when the
  // restricted keys are set up.
  restricted?: RestrictedLock;
};

export type Web = {
  // A new login code; the last one no longer works. `register`: a code to register the phone's
  // passkey instead, kept apart from the link's.
  link(kind?: "login" | "register"): string;
  // Stops serving and removes both sockets. Settles `closed` with "close"; `stop` on the control
  // socket settles it with "stop".
  close(): Promise<void>;
  closed: Promise<Ended>;
};
export type Ended = "close" | "stop";

// Anything else at the path is left alone and refused.
async function clearStale(path: string): Promise<void> {
  const found = await lstat(path).catch(() => null);
  if (found === null) return;
  if (!found.isSocket()) throw refusal("unavailable");
  const answered = await new Promise<boolean>((resolve) => {
    const probe = createConnection({ path });
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
  if (answered) throw refusal("web_running");
  await unlink(path);
}

// Listens on a socket created with the mode the mask leaves.
async function listen(server: Server, path: string, umask: number): Promise<void> {
  const mask = process.umask(umask);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(mask);
  }
}

export async function startWeb({
  socket,
  admin,
  log,
  client,
  tailscale,
  now = systemNow,
  eventsMs = EVENTS_MS,
  nameHoldsMs = NAME_HOLDS_MS,
  relaysMs = RELAYS_MS,
  driveCeilingBytes,
  afterWrite = async () => undefined,
  restricted,
}: WebOptions): Promise<Web> {
  const controlPath = `${socket}-control`;
  const sessions = createSessions(log, now);
  const passkeys = await createCeremonies(`${socket}-passkey`, sessions, log, now, restricted);
  const handle = createRouter({
    admin,
    log,
    client,
    tailscale,
    sessions,
    ceremony: passkeys.ceremony,
    eventsMs,
    driveCeilingBytes,
    afterWrite,
  });
  const link = sessions.link;

  await clearStale(socket);
  await clearStale(controlPath);
  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      log.error({ event: "web_failed", ...faultFields(error) });
      if (!response.headersSent) json(response, 500, { refused: "unavailable" });
      else response.destroy();
    });
  });
  // The control socket: `link` answers a new login code, `register` a code to register the phone's
  // passkey (only with a `ts.net` name set), `stop` ends the server. Only pi opens it.
  const control = createSocketServer((connection) => {
    let text = "";
    connection.setEncoding("utf8");
    connection.on("error", () => {});
    // One word per connection: once answered, nothing more is read.
    let answered = false;
    connection.on("data", (chunk: string) => {
      if (answered) return;
      text += chunk;
      const end = text.indexOf("\n");
      if (end === -1) {
        if (text.length > 16) connection.destroy();
        return;
      }
      const word = text.slice(0, end);
      answered = true;
      if (word === "link") return void connection.end(`${link()}\n`);
      if (word === "register" && tailscale !== undefined) return void connection.end(`${link("register")}\n`);
      if (word === "stop") {
        connection.end("ok\n");
        return void close("stop");
      }
      connection.end("usage\n");
    });
  });
  // The page's socket is 0660, in the process's primary group: on the box `web-serve` starts it
  // with group `piweb`, whose one other member is tailscaled's user. The control socket is 0600,
  // pi's alone.
  await listen(server, socket, 0o117);
  try {
    await listen(control, controlPath, 0o177);
  } catch (error) {
    server.close();
    await unlink(socket).catch(() => {});
    throw error;
  }

  const sweepHolds = async (): Promise<void> => {
    try {
      const swept = await admin.cards.sweepNameHolds();
      if (swept.held + swept.released > 0) log.info({ event: "web_name_holds", counts: swept });
    } catch (error) {
      log.warn({ event: "web_name_holds_failed", code: codeOf(error) });
    }
  };
  const holds = nameHoldsMs > 0 ? setInterval(() => void sweepHolds(), nameHoldsMs) : undefined;
  holds?.unref();
  if (nameHoldsMs > 0) void sweepHolds();

  let applying = false;
  const applyRelays = async (): Promise<void> => {
    if (applying) return;
    applying = true;
    try {
      const done = await admin.cards.applyRelays();
      if (done.applied + done.failed > 0) log.info({ event: "web_relays", counts: done });
    } catch (error) {
      log.warn({ event: "web_relays_failed", code: codeOf(error) });
    } finally {
      applying = false;
    }
  };
  const relays = relaysMs > 0 ? setInterval(() => void applyRelays(), relaysMs) : undefined;
  relays?.unref();
  if (relaysMs > 0) void applyRelays();

  let ended: (how: Ended) => void = () => {};
  const closed = new Promise<Ended>((resolve) => (ended = resolve));
  let closing: Promise<void> | null = null;
  const close = (how: Ended = "close"): Promise<void> => {
    closing ??= Promise.all([
      new Promise<void>((resolve) => {
        clearInterval(holds);
        clearInterval(relays);
        sessions.clear();
        passkeys.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
      new Promise<void>((resolve) => control.close(() => resolve())),
    ]).then(async () => {
      await unlink(socket).catch(() => {});
      await unlink(controlPath).catch(() => {});
      log.info({ event: "web_stopped" });
      ended(how);
    });
    return closing;
  };

  log.info({ event: "web_started", counts: { assets: client.assets.size } });
  return { link, close: () => close(), closed };
}

// The `ts.net` name and the owner's login, set together or not at all.
export function tailscaleOf(env: Env): Tailscale | undefined {
  const host = env.PI_WEB_TS_HOST ?? "";
  const login = env.PI_WEB_TS_LOGIN ?? "";
  if (host === "" && login === "") return undefined;
  if (!TS_HOST.test(host) || !TS_LOGIN.test(login))
    throw refusal(
      "usage",
      "set PI_WEB_TS_HOST to the node's ts.net name and PI_WEB_TS_LOGIN to the owner's Tailscale login, together",
    );
  return { host, login };
}
