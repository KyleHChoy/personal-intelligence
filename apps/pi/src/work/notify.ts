import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import {
  type AgentMessageNotice,
  agentMessageBody,
  type ClientId,
  faultOf,
  type GapBatchNotice,
  gapBatchBody,
  type HealthNotice,
  healthNoticeBody,
  isCoded,
  noticeBody,
  type PersonalLogger,
  ULID_PATTERN,
  type WorkNotice,
  type WorkNoticeCode,
  type WorkNoticeId,
} from "@intelligence/contracts/personal";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";

// `pi notify`, as pi_notify and the Unix user `pinotify`: the work-notice
// sender. It listens for the notice function's wake, and at each wake and every minute delivers
// the notices due, each client's in order on a queue of its own and the clients' queues
// concurrently, so one client's slow endpoint never delays another's notice (invariant 6). Each
// body is a WorkNoticeBody and nothing else, signed with the client's key, which it also carries
// as the `Authorization` header. It holds no key file, no
// model key, no client token and no agent loop, and logs ids, codes and counts, never an address
// or a secret.

const SWEEP_MS = 60_000;
export const TIMEOUT_MS = 5_000;
const RENEW_MS = 24 * 60 * 60 * 1000;
// The waits before each try after the first: 1, 2, 4, 8 and 16 minutes, then `failed`.
const RETRY_MINUTES = Object.freeze([1, 2, 4, 8, 16]);
const READ_HOLD = "/data/read-hold";

// An address the owner may register: https, a host name rather than an address, no
// credentials, at most 2 048 characters. Resolution is checked apart, at set and at send.
export function checkAddress(text: string): URL | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    text.length > 2048 ||
    host === "" ||
    isIP(host) !== 0 ||
    !host.includes(".")
  )
    return null;
  return url;
}

// Every address that is not a public unicast one: loopback, private, link-local, carrier-grade,
// unspecified, multicast, reserved and benchmarking IPv4; and of IPv6 everything outside global
// unicast (2000::/3), with 6to4 (2002::/16) and documentation (2001:db8::/32) inside it, so NAT64,
// IPv4-compatible and IPv4-mapped forms in any spelling are refused but the dotted mapped form,
// which is checked as its IPv4 address.
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped?.[1] ?? address;
  if (isIP(ip) === 4) {
    const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(ip) !== 6) return true;
  const first = ip.toLowerCase().split(":")[0] ?? "";
  const head = first === "" ? 0 : Number.parseInt(first, 16);
  return !(head >= 0x2000 && head <= 0x3fff) || head === 0x2002 || /^2001:0?db8:/i.test(ip);
}

// The host resolved, every answer checked: one private answer refuses the whole name, since a
// resolver may answer with any of them (DNS rebinding). The sender connects to the address it
// checked, never to the name again.
export type Resolved = { address: string; family: 4 | 6 } | "refused" | "unreachable";
export async function resolveChecked(host: string): Promise<Resolved> {
  try {
    // A resolver that does not answer within the send's own timeout is unreachable.
    const answers = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS).unref()),
    ]);
    if (answers.length === 0) return "unreachable";
    if (answers.some((one) => isPrivateAddress(one.address))) return "refused";
    const first = answers[0];
    return first === undefined ? "unreachable" : { address: first.address, family: first.family === 6 ? 6 : 4 };
  } catch {
    return "unreachable";
  }
}

// HMAC-SHA256 under the client's secret of the timestamp, a full stop and the body.
export const signature = (secret: string, timestamp: string, body: string): string =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;

// The body: the notice's own fields and the routine's, the title, details and priority built by
// code from its codes and times; parsed by the schema, so nothing but the schema's leaves, and
// every try of one notice sends the same body. A box health card's notice has a body of its own,
// built the same way.
export const bodyOf = (notice: WorkNotice | HealthNotice | GapBatchNotice | AgentMessageNotice): string =>
  JSON.stringify(
    notice.event === "box_health"
      ? healthNoticeBody(notice)
      : notice.event === "gap_batch"
        ? gapBatchBody(notice)
        : notice.event === "agent_message"
          ? agentMessageBody(notice)
          : noticeBody(notice),
  );

// The secrets file: one key per client id, written by the `pia` wrapper as `pinotify`: the key the
// owner entered for the client (a routine's webhook key) or, when they entered none, one the wrapper
// made. Each request carries it as the `Authorization` header, as it is, and signs with it.
// Refused unless the file is the sender's own user's and mode 0600, and holds nothing but client
// ids and keys of 16 to 512 visible ASCII characters (a header value), optionally after
// `Bearer ` for a receiver that wants that scheme: a compartment
// key file, or anything else, is refused whole.
export const SECRET = /^(?:Bearer )?[\x21-\x7e]{16,512}$/;
export const CLIENT = new RegExp(`^cli_${ULID_PATTERN}$`);
export type Secrets = ReadonlyMap<string, string>;
// A file that does not exist is null; any other failure to read its state refuses, so a fault never
// reads as an absent file.
async function statOrNull(path: string, code = "unavailable"): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isCoded(error, "ENOENT")) return null;
    throw refusal(code);
  }
}

export async function readSecrets(path: string, uid: number | undefined): Promise<{ secrets: Secrets; stamp: string }> {
  const info = await statOrNull(path, "bad_secrets");
  if (info === null) return { secrets: new Map(), stamp: "absent" };
  if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o777) !== 0o600 || !info.isFile())
    throw refusal("bad_secrets");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw refusal("bad_secrets");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw refusal("bad_secrets");
  const entries = Object.entries(parsed);
  if (!entries.every(([client, secret]) => CLIENT.test(client) && typeof secret === "string" && SECRET.test(secret)))
    throw refusal("bad_secrets");
  return { secrets: new Map(entries as [string, string][]), stamp: `${info.mtimeMs}:${info.size}:${info.ino}` };
}

// The secrets, read once at the start, so a file that is refused stops the command before it
// connects, and again whenever the file changed, at each wake and sweep: a new webhook needs no
// restart.
export async function secretsFrom(path: string, uid: number | undefined): Promise<() => Promise<Secrets>> {
  let loaded = await readSecrets(path, uid);
  return async () => {
    const info = await statOrNull(path, "bad_secrets");
    const stamp = info === null ? "absent" : `${info.mtimeMs}:${info.size}:${info.ino}`;
    if (stamp !== loaded.stamp) loaded = await readSecrets(path, uid);
    return loaded.secrets;
  };
}

// One POST to the address checked, no redirect, at most TIMEOUT_MS: the answer's status, or a code.
export type Request = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export function post(
  url: URL,
  resolved: { address: string; family: 4 | 6 },
  headers: Record<string, string>,
  body: string,
  request: Request = httpsRequest,
): Promise<number | "timeout" | "unreachable"> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: number | "timeout" | "unreachable"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = request(
      {
        hostname: url.hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
        // Connected to the address checked; the certificate is still checked against the name.
        lookup: (_host, options, callback) =>
          (options as { all?: boolean }).all === true
            ? (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [
                { address: resolved.address, family: resolved.family },
              ])
            : (callback as (error: null, address: string, family: number) => void)(
                null,
                resolved.address,
                resolved.family,
              ),
        servername: url.hostname,
        agent: false,
      },
      (response) => {
        // The status is the answer: the body is never read, and the socket is closed at once.
        done(response.statusCode ?? 0);
        response.destroy();
        req.destroy();
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done("timeout");
    }, TIMEOUT_MS);
    req.on("error", () => done("unreachable"));
    req.end(body);
  });
}

// What the loop needs of the store, as pi_notify (the store's Notices).
export type NoticeStore = {
  // The clients whose queues are still running are left out, so their backlog never fills the page.
  due(
    now: Date,
    busy: readonly ClientId[],
  ): Promise<
    {
      notice: WorkNotice | HealthNotice | GapBatchNotice | AgentMessageNotice;
      client: ClientId;
      address: string | null;
      attempts: number;
    }[]
  >;
  current(id: WorkNoticeId): Promise<boolean>;
  mark(
    id: WorkNoticeId,
    change: {
      state: "pending" | "delivered" | "failed" | "stale";
      attempts: number;
      lastCode: WorkNoticeCode | null;
      nextTryAt: Date;
      deliveredAt: Date | null;
    },
  ): Promise<void>;
  killSwitch(): Promise<boolean>;
};

export type SenderDeps = {
  store: NoticeStore;
  secrets(): Promise<Secrets>;
  held(): Promise<boolean>;
  resolve(host: string): Promise<Resolved>;
  request?: Request;
  log: PersonalLogger;
  now(): Date;
};

type Outcome = "delivered" | "retried" | "failed" | "stale";

// The sender: `sweep` starts the queue of every client with notices due that has none running,
// and answers when those queues end. A client's queue sends its notices one at a time, in order.
export function createSender(deps: SenderDeps): { sweep(): Promise<void> } {
  const busy = new Set<ClientId>();

  const attempt = async (due: Awaited<ReturnType<NoticeStore["due"]>>[number], secrets: Secrets): Promise<Outcome> => {
    const { notice } = due;
    const id = notice.notice;
    const now = deps.now();
    const attempts = due.attempts + 1;
    const fail = async (code: WorkNoticeCode): Promise<Outcome> => {
      await deps.store.mark(id, { state: "failed", attempts, lastCode: code, nextTryAt: now, deliveredAt: null });
      deps.log.warn({ event: "notify_failed", code, ids: { notice: id } });
      return "failed";
    };
    // Again after 1, 2, 4, 8 and 16 minutes, then failed.
    const retry = async (code: WorkNoticeCode): Promise<Outcome> => {
      const wait = RETRY_MINUTES[attempts - 1];
      if (wait === undefined) return fail(code);
      await deps.store.mark(id, {
        state: "pending",
        attempts,
        lastCode: code,
        nextTryAt: new Date(now.getTime() + wait * 60_000),
        deliveredAt: null,
      });
      return "retried";
    };
    if (!(await deps.store.current(id))) {
      await deps.store.mark(id, {
        state: "stale",
        attempts: due.attempts,
        lastCode: null,
        nextTryAt: now,
        deliveredAt: null,
      });
      return "stale";
    }
    const secret = secrets.get(due.client);
    // Tried again on the retry schedule: the wrapper writes the secret just after the address
    // commits, so a notice in between is not lost; never sent unsigned.
    if (secret === undefined) return retry("no_secret");
    const url = due.address === null ? null : checkAddress(due.address);
    if (url === null) return fail("bad_address");
    const resolved = await deps.resolve(url.hostname);
    if (resolved === "refused") return fail("bad_address");
    const body = bodyOf(notice);
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const answer =
      resolved === "unreachable"
        ? "unreachable"
        : await post(
            url,
            resolved,
            {
              authorization: secret,
              "x-pi-timestamp": timestamp,
              "x-pi-signature": signature(secret, timestamp, body),
            },
            body,
            deps.request,
          );
    if (typeof answer === "number" && answer >= 200 && answer < 300) {
      await deps.store.mark(id, {
        state: "delivered",
        attempts,
        lastCode: null,
        nextTryAt: now,
        deliveredAt: deps.now(),
      });
      return "delivered";
    }
    // A redirect is not followed: it is an answer like any other that is not 2xx.
    return retry(
      typeof answer !== "number"
        ? answer
        : answer >= 300 && answer < 400
          ? "redirect"
          : answer >= 100 && answer <= 599
            ? `http_${answer}`
            : "unreachable",
    );
  };

  return {
    async sweep() {
      try {
        if ((await deps.held()) || (await deps.store.killSwitch())) {
          deps.log.info({ event: "notify_sweep", code: "held" });
          return;
        }
      } catch {
        // A read hold or kill switch that cannot be read stops the sweep: it fails closed.
        deps.log.warn({ event: "notify_sweep", code: "unavailable" });
        return;
      }
      let secrets: Secrets;
      let due: Awaited<ReturnType<NoticeStore["due"]>>;
      try {
        secrets = await deps.secrets();
        due = await deps.store.due(deps.now(), [...busy]);
      } catch (error) {
        const code = isCoded(error) ? error.code : undefined;
        deps.log.warn({ event: "notify_sweep", code: code === "bad_secrets" ? "bad_secrets" : "unavailable" });
        return;
      }
      const byClient = new Map<ClientId, typeof due>();
      for (const one of due)
        if (!busy.has(one.client)) byClient.set(one.client, [...(byClient.get(one.client) ?? []), one]);
      const counts: Record<Outcome, number> = { delivered: 0, retried: 0, failed: 0, stale: 0 };
      await Promise.all(
        [...byClient].map(async ([client, notices]) => {
          busy.add(client);
          try {
            for (const one of notices) counts[await attempt(one, secrets)] += 1;
          } catch {
            deps.log.warn({ event: "notify_failed", code: "unavailable" });
          } finally {
            busy.delete(client);
          }
        }),
      );
      deps.log.info({ event: "notify_sweep", counts });
    },
  };
}

export type LoopDeps = {
  listen(handlers: { onNotice(): void; onLost(): void }): Promise<{ close(): Promise<void> }>;
  sweep(): Promise<void>;
  log: PersonalLogger;
  sweepMs: number;
  renewMs: number;
  now(): number;
  signal?: AbortSignal;
};

// Until the connection is lost, the renewal is due or the signal aborts: a sweep at the start, at
// each wake, and every sweepMs. A wake does not wait for a sweep still running: each sweep skips
// the clients whose queues are busy, so a hanging endpoint holds only its own client. A sweep logs
// and absorbs the faults it expects; one that throws an expected fault anyway is logged and the
// loop goes on, and any other is a bug, which ends the loop by throwing it.
export async function notifyLoop(deps: LoopDeps): Promise<"lost" | "renew" | "stopped"> {
  let lost = false;
  let bug: { error: unknown } | undefined;
  const ended = (): boolean => lost || bug !== undefined || deps.signal?.aborted === true;
  let nudge = (): void => {};
  // Wakes coalesce: while a sweep runs, any number of wakes make one more sweep after it. Each
  // client's queue runs inside a sweep, and a sweep skips the clients still busy, so a hanging
  // endpoint holds only its own client.
  let running: Promise<void> | undefined;
  let again = false;
  const sweep = (): void => {
    if (running !== undefined) {
      again = true;
      return;
    }
    running = deps
      .sweep()
      .catch((error: unknown) => {
        const fault = faultOf(error);
        if (!fault.expected) {
          bug = { error };
          nudge();
          return;
        }
        deps.log.warn({
          event: "notify_sweep",
          code: "unavailable",
          ...(fault.reason === undefined ? {} : { reason: fault.reason }),
        });
      })
      .finally(() => {
        running = undefined;
        if (again && !ended()) {
          again = false;
          sweep();
        }
      });
  };
  const listener = await deps.listen({
    onNotice: () => {
      sweep();
    },
    onLost: () => {
      lost = true;
      nudge();
    },
  });
  const abort = (): void => nudge();
  deps.signal?.addEventListener("abort", abort);
  const renewAt = deps.now() + deps.renewMs;
  try {
    sweep();
    for (;;) {
      if (bug !== undefined) throw bug.error;
      if (lost) return "lost";
      if (deps.signal?.aborted === true) return "stopped";
      if (deps.now() >= renewAt) return "renew";
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            nudge = () => {};
            resolve();
          },
          Math.min(deps.sweepMs, Math.max(0, renewAt - deps.now())),
        );
        nudge = () => {
          clearTimeout(timer);
          nudge = () => {};
          resolve();
        };
      });
      if (!ended()) sweep();
    }
  } finally {
    deps.signal?.removeEventListener("abort", abort);
    again = false;
    await running;
    await listener.close();
  }
}

// The command. notify.env holds exactly PI_DATABASE_URL_NOTIFY and PI_WEBHOOK_SECRETS; the read
// hold is the box's file, which PI_READ_HOLD may name instead for a test.
export async function notify({ env, log }: CommandContext): Promise<0> {
  const path = env.PI_WEBHOOK_SECRETS ?? "";
  if (!/^\/[A-Za-z0-9._/-]+$/.test(path)) throw refusal("bad_env");
  const uid = process.getuid?.();
  const secrets = await secretsFrom(path, uid);
  const hold = (env.PI_READ_HOLD ?? "") === "" ? READ_HOLD : (env.PI_READ_HOLD as string);
  const url = env.PI_DATABASE_URL_NOTIFY ?? "";
  const { createNotices, listenNotices } = await import("@intelligence/personal-store");
  const store = createNotices(url, log);
  try {
    const sender = createSender({
      store,
      secrets,
      held: async () => (await statOrNull(hold)) !== null,
      resolve: resolveChecked,
      log,
      now: () => new Date(),
    });
    const end = await notifyLoop({
      listen: (handlers) => listenNotices(url, log, handlers),
      sweep: sender.sweep,
      log,
      sweepMs: SWEEP_MS,
      renewMs: RENEW_MS,
      now: Date.now,
    });
    log.info({ event: "notify_end", code: end });
    if (end === "lost") throw refusal("unavailable");
    return 0;
  } finally {
    await store.close();
  }
}
