import { createHmac } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClientId,
  HealthNotice,
  PersonalLogEvent,
  WorkNotice,
  WorkNoticeId,
} from "@intelligence/contracts/personal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientsWebhookSet } from "../agents/clients.ts";
import { checkRole } from "../env.ts";
import {
  bodyOf,
  checkAddress,
  createSender,
  isPrivateAddress,
  type NoticeStore,
  notifyLoop,
  type Request,
  type Resolved,
  SECRET,
  secretsFrom,
  signature,
} from "./notify.ts";

// The work-notice sender, against fake endpoints on this machine's
// loopback (reached through an injected resolver and plain http, since the real ones refuse both).
// Synthetic ids and reserved names only.

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const A = `cli_${ULID.slice(0, 25)}A` as ClientId;
const B = `cli_${ULID.slice(0, 25)}B` as ClientId;
const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);
const noticeOf = (n: string, event: WorkNotice["event"] = "routed"): WorkNotice =>
  ({
    notice: `ntc_${ULID.slice(0, 25)}${n}`,
    event,
    opportunity: `opp_${ULID}`,
    tier: "task",
    kind: "research",
    role: "chief-of-staff",
    at: "2026-10-22T10:00:00.000Z",
    deadline: null,
  }) as WorkNotice;
// A routine's webhook key, as the owner enters it: not hexadecimal, sent as it is.
const ROUTINE_KEY = "rk-TEST_routine.key/0123456789+abc=";

type Mark = { id: WorkNoticeId; state: string; lastCode: string | null; at: number };
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function endpoint(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ port: number; seen: { headers: IncomingMessage["headers"]; body: string }[] }> {
  const seen: { headers: IncomingMessage["headers"]; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ headers: req.headers, body });
      handler(req, res, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

function world(options: {
  due: { notice: WorkNotice | HealthNotice; client: ClientId; address: string | null; attempts?: number }[];
  current?: boolean;
  kill?: boolean;
  held?: boolean;
  secrets?: Map<string, string>;
}) {
  const marks: Mark[] = [];
  const events: PersonalLogEvent[] = [];
  const store: NoticeStore = {
    due: async () => options.due.map((one) => ({ ...one, attempts: one.attempts ?? 0 })),
    current: async () => options.current ?? true,
    mark: async (id, change) => {
      marks.push({ id, state: change.state, lastCode: change.lastCode, at: Date.now() });
    },
    killSwitch: async () => options.kill === true,
  };
  const resolve = async (): Promise<Resolved> => ({ address: "127.0.0.1", family: 4 });
  const log = {
    info: (e: PersonalLogEvent) => events.push(e),
    warn: (e: PersonalLogEvent) => events.push(e),
    error: (e: PersonalLogEvent) => events.push(e),
  };
  const sender = createSender({
    store,
    secrets: async () =>
      options.secrets ??
      new Map([
        [A, SECRET_A],
        [B, SECRET_B],
      ]),
    held: async () => options.held === true,
    resolve,
    request: httpRequest as unknown as Request,
    log,
    now: () => new Date(),
  });
  return { sender, marks, events };
}

describe("pi notify", () => {
  it("a key may be stored after `Bearer `, for a receiver that wants that scheme, and nothing else is let in", () => {
    expect(SECRET.test("k".repeat(16))).toBe(true);
    expect(SECRET.test(`Bearer ${"k".repeat(16)}`)).toBe(true);
    for (const refused of [
      "Bearer ",
      `Bearer  ${"k".repeat(16)}`,
      `bearer ${"k".repeat(16)}`,
      `Basic ${"k".repeat(16)}`,
      `Bearer ${"k".repeat(15)}`,
      `${"k".repeat(16)} x`,
    ])
      expect(SECRET.test(refused)).toBe(false);
  });

  it("the body is exactly the routine's fields and the notice's own, id and kind at the top level, title and details from codes alone", () => {
    const body = JSON.parse(bodyOf({ ...noticeOf("1"), deadline: "2026-10-22T20:00:00.000Z" })) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual([
      "at",
      "deadline",
      "details",
      "event",
      "id",
      "kind",
      "notice",
      "opportunity",
      "priority",
      "role",
      "tier",
      "title",
    ]);
    expect(body).toEqual({
      id: `opp_${ULID}`,
      kind: "research",
      title: "PI task: research (routed)",
      details: `Claim it with claim_opportunity opp_${ULID}. The brief comes with the claim. Event: routed. Role: chief-of-staff.`,
      deadline: "2026-10-22T20:00:00.000Z",
      priority: "high",
      notice: noticeOf("1").notice,
      event: "routed",
      opportunity: `opp_${ULID}`,
      tier: "task",
      role: "chief-of-staff",
      at: "2026-10-22T10:00:00.000Z",
    });
    // A notice carrying anything else, such as a summary with a name, sends none of it.
    expect(bodyOf({ ...noticeOf("1"), summary: "Meet Alex Example about the clinic" } as WorkNotice)).toBe(
      bodyOf(noticeOf("1")),
    );
  });

  it("the signature verifies with the client's secret and fails with another", () => {
    const body = bodyOf(noticeOf("1"));
    const header = signature(SECRET_A, "1761127200", body);
    const expected = `sha256=${createHmac("sha256", SECRET_A).update(`1761127200.${body}`).digest("hex")}`;
    expect(header).toBe(expected);
    expect(signature(SECRET_B, "1761127200", body)).not.toBe(expected);
    expect(signature(SECRET_A, "1761127201", body)).not.toBe(expected);
  });

  it("an address on a loopback, private, link-local or carrier-grade range, by literal or by resolution, is refused and nothing is sent", async () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
      "64:ff9b::a9fe:a9fe",
      "2002:a00:1::1",
      "2001:db8::1",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "ff02::1",
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "100.128.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
    for (const text of [
      "http://agent.example.org/hook",
      "https://127.0.0.1/hook",
      "https://[::1]/hook",
      "https://user:pw@agent.example.org/hook",
      "https://localhost/hook",
      "not a url",
    ])
      expect(checkAddress(text), text).toBeNull();
    expect(checkAddress("https://agent.example.org/hook?x=1")?.hostname).toBe("agent.example.org");
    const hit = await endpoint((_req, res) => res.writeHead(204).end());
    const marks: Mark[] = [];
    const resolved = createSender({
      store: {
        due: async () => [
          { notice: noticeOf("1"), client: A, address: `https://agent-a.example.org:${hit.port}/hook`, attempts: 0 },
        ],
        current: async () => true,
        mark: async (id, change) => void marks.push({ id, state: change.state, lastCode: change.lastCode, at: 0 }),
        killSwitch: async () => false,
      },
      secrets: async () => new Map([[A, SECRET_A]]),
      held: async () => false,
      resolve: async () => "refused",
      request: httpRequest as unknown as Request,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => new Date(),
    });
    await resolved.sweep();
    expect(hit.seen).toEqual([]);
    expect(marks).toMatchObject([{ state: "failed", lastCode: "bad_address" }]);
  });

  it("a redirect is not followed", async () => {
    const elsewhere = await endpoint((_req, res) => res.writeHead(204).end());
    const redirecting = await endpoint((_req, res) =>
      res.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/` }).end(),
    );
    const { sender, marks } = world({
      due: [{ notice: noticeOf("1"), client: A, address: `https://agent-a.example.org:${redirecting.port}/hook` }],
    });
    await sender.sweep();
    expect(redirecting.seen).toHaveLength(1);
    expect(elsewhere.seen).toEqual([]);
    expect(marks).toMatchObject([{ state: "pending", lastCode: "redirect" }]);
  });

  it("a delivered notice carries the signed body; a client whose endpoint hangs for the whole timeout delays no other client's notice", async () => {
    const hanging = await endpoint(() => {});
    const quick = await endpoint((_req, res) => res.writeHead(204).end());
    const { sender, marks } = world({
      due: [
        { notice: noticeOf("1"), client: A, address: `https://agent-a.example.org:${hanging.port}/hook` },
        { notice: noticeOf("2"), client: B, address: `https://agent-b.example.org:${quick.port}/hook` },
      ],
    });
    const started = Date.now();
    await sender.sweep();
    const b = marks.find((mark) => mark.id === noticeOf("2").notice);
    const a = marks.find((mark) => mark.id === noticeOf("1").notice);
    expect(b).toMatchObject({ state: "delivered" });
    expect((b?.at ?? Infinity) - started).toBeLessThan(2_000);
    expect(a).toMatchObject({ state: "pending", lastCode: "timeout" });
    const [request] = quick.seen;
    expect(request?.body).toBe(bodyOf(noticeOf("2")));
    expect(request?.headers.authorization).toBe(SECRET_B);
    expect(request?.headers["x-pi-signature"]).toBe(
      signature(SECRET_B, String(request?.headers["x-pi-timestamp"]), request?.body ?? ""),
    );
  }, 15_000);

  // A box health card's notice goes the same way, signed, with its own body.
  it("a box health notice is sent and signed as a work notice is, its body the card's codes alone", async () => {
    const quick = await endpoint((_req, res) => res.writeHead(204).end());
    const health: HealthNotice = {
      notice: `ntc_${ULID.slice(0, 25)}9`,
      event: "box_health",
      card: `crd_${ULID}`,
      kind: "restarting",
      about: "notify",
      at: "2026-10-30T10:00:00.000Z",
    } as HealthNotice;
    const { sender, marks } = world({
      due: [{ notice: health, client: A, address: `https://agent-a.example.org:${quick.port}/hook` }],
    });
    await sender.sweep();
    expect(marks).toEqual([expect.objectContaining({ id: health.notice, state: "delivered" })]);
    const [request] = quick.seen;
    const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "about",
      "at",
      "card",
      "deadline",
      "details",
      "event",
      "id",
      "kind",
      "notice",
      "priority",
      "title",
    ]);
    expect(body).toMatchObject({
      id: `crd_${ULID}`,
      event: "box_health",
      kind: "restarting",
      about: "notify",
      title: "PI box health: restarting (notify)",
      priority: "high",
      deadline: null,
    });
    expect(request?.headers["x-pi-signature"]).toBe(
      signature(SECRET_A, String(request?.headers["x-pi-timestamp"]), request?.body ?? ""),
    );
  });

  it("the Authorization header carries the stored key as it is, beside the signature; the logs never hold it", async () => {
    const hit = await endpoint((_req, res) => res.writeHead(202).end());
    const down = await endpoint((_req, res) => res.writeHead(401).end());
    const { sender, marks, events } = world({
      due: [
        { notice: noticeOf("1"), client: A, address: `https://agent-a.example.org:${hit.port}/hook` },
        { notice: noticeOf("2"), client: B, address: `https://agent-b.example.org:${down.port}/hook`, attempts: 5 },
      ],
      secrets: new Map([
        [A, ROUTINE_KEY],
        [B, `${ROUTINE_KEY}b`],
      ]),
    });
    await sender.sweep();
    const [request] = hit.seen;
    expect(request?.headers.authorization).toBe(ROUTINE_KEY);
    expect(request?.headers["x-pi-signature"]).toBe(
      signature(ROUTINE_KEY, String(request?.headers["x-pi-timestamp"]), request?.body ?? ""),
    );
    expect(down.seen[0]?.headers.authorization).toBe(`${ROUTINE_KEY}b`);
    expect(marks.find((mark) => mark.id === noticeOf("1").notice)).toMatchObject({ state: "delivered" });
    expect(marks.find((mark) => mark.id === noticeOf("2").notice)).toMatchObject({
      state: "failed",
      lastCode: "http_401",
    });
    expect(JSON.stringify(events)).not.toContain(ROUTINE_KEY.slice(0, 16));
  });

  it("a failure is retried at 1, 2, 4, 8 and 16 minutes, then failed", async () => {
    const down = await endpoint((_req, res) => res.writeHead(503).end());
    for (const [attempts, state] of [
      [0, "pending"],
      [4, "pending"],
      [5, "failed"],
    ] as const) {
      const { sender, marks } = world({
        due: [{ notice: noticeOf("1"), client: A, address: `https://agent-a.example.org:${down.port}/hook`, attempts }],
      });
      await sender.sweep();
      expect(marks, String(attempts)).toMatchObject([{ state, lastCode: "http_503" }]);
    }
  });

  it("a wake delivers a pending notice without waiting for the sweep", async () => {
    let wake = (): void => {};
    let sweeps = 0;
    const controller = new AbortController();
    const loop = notifyLoop({
      listen: async (handlers) => {
        wake = handlers.onNotice;
        return { close: async () => {} };
      },
      sweep: async () => {
        sweeps += 1;
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      sweepMs: 60_000,
      renewMs: 3_600_000,
      now: Date.now,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(sweeps).toBe(1), { timeout: 20_000 });
    wake();
    await vi.waitFor(() => expect(sweeps).toBe(2), { timeout: 20_000 });
    controller.abort();
    expect(await loop).toBe("stopped");
  });

  it("a sweep's expected fault is logged and the loop goes on; a bug ends the loop by throwing it", async () => {
    const warned: PersonalLogEvent[] = [];
    const log = { info: () => {}, warn: (event: PersonalLogEvent) => void warned.push(event), error: () => {} };
    const listen = async () => ({ close: async () => {} });
    let sweeps = 0;
    const controller = new AbortController();
    const going = notifyLoop({
      listen,
      sweep: async () => {
        sweeps += 1;
        throw Object.assign(new Error("db.example.com"), { code: "ECONNREFUSED" });
      },
      log,
      sweepMs: 5,
      renewMs: 3_600_000,
      now: Date.now,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(sweeps).toBeGreaterThan(1), { timeout: 20_000 });
    expect(warned[0]).toEqual({ event: "notify_sweep", code: "unavailable", reason: "econnrefused" });
    controller.abort();
    expect(await going).toBe("stopped");

    const thrown = new TypeError("owner@example.com");
    let closed = 0;
    const ended = notifyLoop({
      listen: async () => ({ close: async () => void (closed += 1) }),
      sweep: () => Promise.reject(thrown),
      log,
      sweepMs: 60_000,
      renewMs: 3_600_000,
      now: Date.now,
    });
    await expect(ended).rejects.toBe(thrown);
    expect(closed).toBe(1);
  });

  it("a notice notice_current refuses is marked stale and not sent", async () => {
    const hit = await endpoint((_req, res) => res.writeHead(204).end());
    const { sender, marks } = world({
      due: [{ notice: noticeOf("1"), client: A, address: `https://agent-a.example.org:${hit.port}/hook` }],
      current: false,
    });
    await sender.sweep();
    expect(hit.seen).toEqual([]);
    expect(marks).toMatchObject([{ state: "stale" }]);
  });

  it("a client with an address and no secret gets no request: its notice waits on the retry schedule with no_secret, then fails", async () => {
    const hit = await endpoint((_req, res) => res.writeHead(204).end());
    const { sender, marks } = world({
      due: [{ notice: noticeOf("1"), client: A, address: `https://agent-a.example.org:${hit.port}/hook` }],
      secrets: new Map([[B, SECRET_B]]),
    });
    await sender.sweep();
    expect(hit.seen).toEqual([]);
    expect(marks).toMatchObject([{ state: "pending", lastCode: "no_secret" }]);
    const last = world({
      due: [{ notice: noticeOf("1"), client: A, address: `https://agent-a.example.org:${hit.port}/hook`, attempts: 5 }],
      secrets: new Map([[B, SECRET_B]]),
    });
    await last.sender.sweep();
    expect(hit.seen).toEqual([]);
    expect(last.marks).toMatchObject([{ state: "failed", lastCode: "no_secret" }]);
  });

  it("nothing is sent with the kill switch on, or while the read hold exists", async () => {
    const hit = await endpoint((_req, res) => res.writeHead(204).end());
    for (const stop of [{ kill: true }, { held: true }]) {
      const { sender, marks } = world({
        due: [{ notice: noticeOf("1"), client: A, address: `https://agent-a.example.org:${hit.port}/hook` }],
        ...stop,
      });
      await sender.sweep();
      expect(marks).toEqual([]);
    }
    expect(hit.seen).toEqual([]);
  });

  it("a secret added to the file after start is used at the next wake; a file not 0600, or holding anything but client secrets, is refused", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pi-notify-"));
    try {
      const path = join(folder, "webhooks.json");
      await writeFile(path, JSON.stringify({ [A]: SECRET_A }), { mode: 0o600 });
      const secrets = await secretsFrom(path, process.getuid?.());
      expect((await secrets()).get(B)).toBeUndefined();
      await writeFile(path, JSON.stringify({ [A]: SECRET_A, [B]: SECRET_B }));
      await chmod(path, 0o600);
      expect((await secrets()).get(B)).toBe(SECRET_B);
      await chmod(path, 0o644);
      await expect(secretsFrom(path, process.getuid?.())).rejects.toMatchObject({ code: "bad_secrets" });
      await writeFile(path, JSON.stringify({ own: "k".repeat(44), fingerprint: "f".repeat(44) }));
      await chmod(path, 0o600);
      await expect(secretsFrom(path, process.getuid?.())).rejects.toMatchObject({ code: "bad_secrets" });
      // A routine's key the owner entered is taken as it is; one that is no header value is refused.
      await writeFile(path, JSON.stringify({ [A]: ROUTINE_KEY }));
      expect((await (await secretsFrom(path, process.getuid?.()))()).get(A)).toBe(ROUTINE_KEY);
      for (const bad of ["short-key", `${ROUTINE_KEY} x`, `${ROUTINE_KEY}\r\nx-other: 1`, "k".repeat(513)]) {
        await writeFile(path, JSON.stringify({ [A]: bad }));
        await expect(secretsFrom(path, process.getuid?.()), bad.slice(0, 20)).rejects.toMatchObject({
          code: "bad_secrets",
        });
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("the start refuses a key file, a client token or another role's URL; every other command refuses the notify URL", () => {
    const own = {
      PI_DATABASE_URL_NOTIFY: "postgres://pi_notify:x@db/pi",
      PI_WEBHOOK_SECRETS: "/data/pinotify/webhooks.json",
    };
    expect(() => checkRole("notify", own)).not.toThrow();
    for (const extra of [
      { PI_KEY_FILE: "/data/pi/keys.json" },
      { PI_CLIENT_TOKEN: "pit_x" },
      { PI_DATABASE_URL_WORK: "postgres://pi_work:x@db/pi" },
      { PI_DATABASE_URL_PROXY: "postgres://pi_proxy:x@db/pi" },
      { PI_OPENROUTER_KEY: "sk-or-x" },
    ]) {
      expect(() => checkRole("notify", { ...own, ...extra }), Object.keys(extra)[0]).toThrow(
        expect.objectContaining({ code: "wrong_role_url" }),
      );
    }
    for (const role of ["admin", "work", "proxy", "reader", "bootstrap", "none", "pipeline"] as const) {
      expect(() => checkRole(role, { PI_DATABASE_URL_NOTIFY: own.PI_DATABASE_URL_NOTIFY }), role).toThrow(
        expect.objectContaining({ code: "wrong_role_url" }),
      );
    }
  });

  it("clients webhook set refuses an http address, one with credentials and one on a private address, before it connects", async () => {
    const context = (url: string) =>
      ({
        positionals: ["agent-a", url],
        values: {},
        env: {},
        io: undefined,
        log: { info: () => {}, warn: () => {}, error: () => {} },
        deps: {},
      }) as unknown as Parameters<typeof clientsWebhookSet>[0];
    // No PI_DATABASE_URL_ADMIN in the environment: had any reached the store, it would fail otherwise.
    for (const url of [
      "http://agent.example.org/hook",
      "https://owner:pw@agent.example.org/hook",
      "https://10.0.0.5/hook",
      "https://[fd00::1]/hook",
    ]) {
      await expect(clientsWebhookSet(context(url)), url).rejects.toMatchObject({ code: "bad_address" });
    }
  });

  it("the log lines hold no address and no secret", async () => {
    const down = await endpoint((_req, res) => res.writeHead(500).end());
    const { sender, events } = world({
      due: [
        { notice: noticeOf("1"), client: A, address: `https://agent-a.example.org:${down.port}/hook`, attempts: 5 },
      ],
    });
    await sender.sweep();
    const text = JSON.stringify(events);
    expect(events.map((event) => event.event)).toEqual(["notify_failed", "notify_sweep"]);
    expect(text).not.toContain("example.org");
    expect(text).not.toContain(SECRET_A);
  });
});
