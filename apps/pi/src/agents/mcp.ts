import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { isIP } from "node:net";
import type { PersonalLogEvent, PersonalLogger } from "@intelligence/contracts/personal";
import { serveHttp, serveStdio } from "@intelligence/personal-mcp";
import { boxHostOf, createReader, createWork, journalPath, reloadingKeys, tallied } from "@intelligence/personal-store";
import { captureCeilingOf, mirrorPassSecondsOf, mirrorRebuildHoursOf } from "../box/env-numbers.ts";
import type { CommandContext } from "../command-types.ts";
import { deployedCommit } from "../deployed-commit.ts";
import { codeOf, refusal } from "../env.ts";
import { boxFacts } from "./box-facts.ts";

// A logger that holds every line from `hold` until `flush`, and writes
// a line at once otherwise. `serveStdio` holds it from the moment a message's line is complete
// and flushes it once the reply is written, so a call's lines, the store's and the agent API's
// alike, reach stderr after its reply: over the bridge the client's process reads stderr, and a
// line written when the work ended would tell it the time the reply deadline hides.
export function holdLog(log: PersonalLogger): { log: PersonalLogger; hold(): void; flush(): void } {
  const held: { level: keyof PersonalLogger; event: PersonalLogEvent }[] = [];
  let holding = false;
  const write =
    (level: keyof PersonalLogger) =>
    (event: PersonalLogEvent): void => {
      if (holding) held.push({ level, event });
      else log[level](event);
    };
  return {
    log: { info: write("info"), warn: write("warn"), error: write("error") },
    hold: () => {
      holding = true;
    },
    flush: () => {
      holding = false;
      for (const { level, event } of held.splice(0)) log[level](event);
    },
  };
}

// `pi mcp`: the agent API on stdin and stdout, for the client whose token is in the
// environment. The store's Reader is the context provider, handed
// over as it is, as both ports: it answers the reads and appends agent records, and nothing is
// added to what it answers. It also counts each session taint decision (taintLedger). The process's
// input is one session, whose label lives as long as the process. The store's Work, built from that reader, answers the work and run
// tools through the reader's own call path: one pool, and one session for the client, whichever
// served its first call. Nothing but JSON-RPC goes
// to stdout. Every tool call is answered at its reply deadline (`serveStdio`), and every log line
// of the agent API and the store is held and written after the reply it belongs to.
export async function mcpCommand({ env, io, log }: CommandContext): Promise<0> {
  const held = holdLog(log);
  const { reader, work, commit } = await openAgentApi(env, held.log);
  // A client that goes away closes the pipe. Its error is taken here, so it is never an
  // uncaught one.
  let closed = false;
  io.stdout.on("error", () => {
    closed = true;
  });
  try {
    await checkErasures(reader);
    // An unset token is no token: the agent API still starts, and answers `unauthorized`.
    await serveStdio(
      { provider: reader, work, commit, taintLedger: reader },
      held.log,
      env.PI_CLIENT_TOKEN || undefined,
      io.stdin,
      io.stdout,
      {
        logs: held,
      },
    );
  } catch (error) {
    // It rejects on a stream's error. The output's own error event follows the failed write
    // within the tick; once it has come there is nobody left to answer, and the command ends
    // quietly. The process's stdout never reports itself closed, so the event is what is read.
    await new Promise((resolve) => setImmediate(resolve));
    if (!closed) throw error;
  } finally {
    await reader.close();
    held.flush();
  }
  return 0;
}

// The reader and work of the agent API, as `pi mcp` and `pi http` both open them. The key file is
// read again when it changes: a client given record after the process started (`pia clients add`,
// `set-tools`) has its agent key at its next call, without a restart. A push meets the storage
// ceiling of PI_CAPTURE_STORAGE_CEILING_BYTES, or the store's default; a mirror's passes
// PI_MIRROR_PASS_SECONDS and PI_MIRROR_REBUILD_HOURS apart. `pi mcp` gives none, so a push through
// it admits nothing by default.
async function openAgentApi(env: CommandContext["env"], log: PersonalLogger, boxHost?: string) {
  const keyFile = env.PI_KEY_FILE ?? "";
  const ceiling = captureCeilingOf(env);
  // Lens's mirror: the pass and rebuild intervals, or the store's defaults.
  const passSeconds = mirrorPassSecondsOf(env);
  const rebuildHours = mirrorRebuildHoursOf(env);
  const reader = createReader({
    url: env.PI_DATABASE_URL_READER ?? "",
    keys: await reloadingKeys(keyFile),
    log,
    journal: journalPath(keyFile),
    ...(ceiling === undefined ? {} : { captureCeilingBytes: ceiling }),
    ...(boxHost === undefined ? {} : { boxHost }),
    ...(passSeconds === undefined ? {} : { mirrorPassSeconds: passSeconds }),
    ...(rebuildHours === undefined ? {} : { mirrorRebuildHours: rebuildHours }),
  });
  // The commit this image was built from, which `initialize` answers as the server's version.
  return { reader, work: createWork({ reader, log, box: boxFacts }), commit: deployedCommit() };
}

// It serves nothing before the erasures made since a restore are
// applied. A database it cannot reach yet is no answer: it serves, and the reader asks again
// before its first call that reaches the database, answering `unavailable` until the two are level.
async function checkErasures(reader: { erasureLevel(): Promise<string> }): Promise<void> {
  const level = await reader.erasureLevel().catch((error: unknown) => {
    if (codeOf(error) !== "unavailable") throw error;
    return "unknown";
  });
  if (level === "behind") throw refusal("erasure_replay_needed");
}

// PI_HTTP_BASE_URL: the public https origin OAuth is served under, or
// undefined when it is unset, which leaves OAuth off. Anything but a bare https origin is refused.
export function baseUrlOf(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refusal("invalid_base_url");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/" ||
    !/^https:\/\/[^/]+\/?$/.test(value)
  ) {
    throw refusal("invalid_base_url");
  }
  return url.origin;
}

// PI_HTTP_HOST: the address `pi http` listens on, an IP address such as 127.0.0.1 or ::1, or
// undefined when it is unset, which listens on every interface. The box leaves it unset, since
// its host's proxy reaches the container from outside; a local run sets 127.0.0.1. Anything but
// an IP address is a usage error, so a name never resolves to an interface nobody chose.
export function httpHostOf(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (isIP(value) === 0) throw refusal("usage");
  return value;
}

// PI_HTTP_TRUST_PROXY: `1` when a proxy the owner configured stands in front of `pi http` and adds
// the caller's address to X-Forwarded-For, as the box's host does; unset or empty, the header is
// ignored and every per-address limit keys on the socket's address. Anything else is a usage error.
export function trustProxyOf(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value === "1") return true;
  throw refusal("usage");
}

// Listens on PORT at HOST, or on every interface when HOST is undefined; rejects on a listen
// error. Once listening, the listen error's handler is removed, so a later server error is not
// swallowed by a promise already settled.
export function listenAt(server: Server, port: number, host: string | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen({ port, ...(host === undefined ? {} : { host }) }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

// `pi http`: the same agent API over HTTP on PI_HTTP_PORT at PI_HTTP_HOST, behind the proxy
// PI_HTTP_TRUST_PROXY names, with
// the credentials `pi mcp` holds and nothing more: each request carries its client's token as a
// bearer token. While the file PI_READ_HOLD names exists it answers unavailable. It serves until
// SIGTERM or SIGINT. Its log lines are not held: an HTTP client never reads this process's stderr. With
// PI_HTTP_BASE_URL it serves OAuth too, through the reader's own pool. Where the schema mark is
// (SCHEMA_MARK: the box's start writes it and `pi-migrate` too, whether the database has applied this
// image's migrations), /healthz answers ok only while it says `current`; with no mark, always.
// The schema mark: one word, `unknown`, `behind` or `current`, written as root by the entrypoint,
// lib/migrate-start and pi-migrate. With no file this is not the box, and nothing is checked; any
// other mark that cannot be read says nothing is known.
export const SCHEMA_MARK = "/run/pistate/schema";
export function schemaMarked(path: string): boolean {
  try {
    return readFileSync(path, "utf8").trim() === "current";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function httpCommand({ env, log }: CommandContext): Promise<0> {
  const port = Number(env.PI_HTTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw refusal("usage");
  const host = httpHostOf(env.PI_HTTP_HOST);
  const base = baseUrlOf(env.PI_HTTP_BASE_URL);
  const trustForwarded = trustProxyOf(env.PI_HTTP_TRUST_PROXY);
  const hold = env.PI_READ_HOLD ?? "";
  const { reader, work, commit } = await openAgentApi(env, log, boxHostOf(base));
  try {
    await checkErasures(reader);
    const server = serveHttp({ provider: reader, work, commit, taintLedger: reader }, log, {
      held: () => hold !== "" && existsSync(hold),
      schemaCurrent: () => schemaMarked(SCHEMA_MARK),
      trustForwarded,
      tally: tallied,
      ...(base === undefined ? {} : { oauth: { base, store: reader.oauth } }),
    });
    await listenAt(server, port, host);
    log.info({ event: "http_listening", counts: { port } });
    await new Promise((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await reader.close();
  }
  return 0;
}
