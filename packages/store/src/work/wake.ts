import { CodedError, type PersonalLogger } from "@intelligence/contracts/personal";
import pg from "pg";
import { parseDatabaseUrl } from "../core/db.ts";

const AGENT_WRITE_CHANNEL = "pi_agent_write";

// How often the listener asks the server whether its connection still answers, and
// how long it waits for the answer and for a connection. A half-open connection delivers no
// notice and raises no error; the ping finds it, and the listener's supervisor starts it again.
const LISTEN_PING_MS = 60_000;
const LISTEN_TIMEOUT_MS = 10_000;

export type AgentWriteListener = { close(): Promise<void> };

// `ping` every `everyMs`; one that fails, or has not answered within `timeoutMs`, calls `onLost`
// once. The returned function stops it.
export function watchConnection(
  ping: () => Promise<unknown>,
  everyMs: number,
  timeoutMs: number,
  onLost: () => void,
): () => void {
  let stopped = false;
  const fail = (): void => {
    if (stopped) return;
    stop();
    onLost();
  };
  const timer = setInterval(() => {
    const late = setTimeout(fail, timeoutMs);
    ping().then(
      () => clearTimeout(late),
      () => {
        clearTimeout(late);
        fail();
      },
    );
  }, everyMs);
  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };
  return stop;
}

// One connection of its own that listens on the channel, as pi_pipeline for `pi extract wake`.
// `onNotice` is called once for each notification; `onLost` once, when the connection ends, fails
// or stops answering its ping, after which nothing more is called. A URL that does not parse is
// refused as `bad_url`.
export const listenAgentWrites = (
  url: string,
  log: PersonalLogger,
  handlers: { onNotice(): void; onLost(): void },
): Promise<AgentWriteListener> => listenChannel(AGENT_WRITE_CHANNEL, url, log, handlers);

// The same on any channel, such as `pi notify`'s, as pi_notify.
export async function listenChannel(
  channel: string,
  url: string,
  log: PersonalLogger,
  handlers: { onNotice(): void; onLost(): void },
): Promise<AgentWriteListener> {
  const client = new pg.Client({
    connectionString: parseDatabaseUrl(url).href,
    keepAlive: true,
    connectionTimeoutMillis: LISTEN_TIMEOUT_MS,
    query_timeout: LISTEN_TIMEOUT_MS,
  });
  let ended = false;
  let unwatch = (): void => {};
  const lost = (): void => {
    if (ended) return;
    ended = true;
    unwatch();
    handlers.onLost();
  };
  client.on("notification", (message) => {
    if (!ended && message.channel === channel) handlers.onNotice();
  });
  // The driver's error carries the server's text: it goes no further than this line.
  client.on("error", () => {
    log.warn({ event: "connection_lost", code: "unavailable" });
    lost();
  });
  client.on("end", lost);
  try {
    await client.connect();
    await client.query(`listen ${pg.escapeIdentifier(channel)}`);
  } catch {
    ended = true;
    await client.end().catch(() => {});
    throw new CodedError("unavailable");
  }
  unwatch = watchConnection(
    () => client.query("select 1"),
    LISTEN_PING_MS,
    LISTEN_TIMEOUT_MS,
    () => {
      log.warn({ event: "connection_lost", code: "unavailable" });
      lost();
      void client.end().catch(() => {});
    },
  );
  return {
    async close() {
      ended = true;
      unwatch();
      await client.end().catch(() => {});
    },
  };
}
