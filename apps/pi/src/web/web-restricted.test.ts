import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PASSKEY_CATEGORIES, type PersonalLogEvent, UNLOCK_WINDOW_MS } from "@intelligence/contracts/personal";
import type { Admin } from "@intelligence/personal-store";
import { createRestrictedUnlock, type RestrictedUnlock, wrapRestrictedFile } from "@intelligence/personal-store";
import { afterEach, describe, expect, it } from "vitest";
import { type Authenticator, assertion, authenticator, registration, UP } from "../test-support/passkey-fixtures.ts";
import { control } from "../test-support/web-control.ts";
import { startWeb, type Tailscale, type Web } from "./web.ts";
import { loadClient } from "./web-client.ts";

// The restricted keys' unlock on the dashboard: within a session, a fresh passkey assertion with
// the passkey's PRF output, or the owner's recovery secret the first time, opens the keys in `pi
// web`'s memory for the window, and nothing else does.

const T0 = new Date("2026-11-16T12:00:00.000Z");
const TS: Tailscale = { host: "box.tail1234.ts.net", login: "owner@example.com" };
const HEADERS = { "tailscale-user-login": TS.login };
const ORIGIN = `https://${TS.host}`;
const LOCKED = PASSKEY_CATEGORIES.map((category) => `restricted:${category}`).sort();

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function post(socket: string, path: string, json: unknown, cookie?: string, origin = ORIGIN): Promise<Answer> {
  const body = JSON.stringify(json);
  const headers: Record<string, string> = {
    host: TS.host,
    ...HEADERS,
    origin,
    "content-type": "application/json",
    ...(cookie === undefined ? {} : { cookie }),
  };
  return new Promise((resolve, reject) => {
    const sent = request({ socketPath: socket, path, method: "POST", headers, setHost: false }, (response) => {
      let text = "";
      response.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
    });
    sent.on("error", reject);
    sent.end(body);
  });
}

const folders: string[] = [];
const servers: Web[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

type Started = {
  socket: string;
  restricted: string;
  recovery: string;
  unlock: RestrictedUnlock;
  clock: { now: Date };
  logged: PersonalLogEvent[];
  device: Authenticator;
  cookie: string;
};

// A server with a wrapped restricted file beside its key file, and the phone's passkey registered:
// the passkey session's cookie.
async function started(): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-restricted-"));
  folders.push(dir);
  const socket = join(dir, "keys.json.web");
  const restricted = join(dir, "restricted-keys.json");
  const recovery = await wrapRestrictedFile(restricted, LOCKED);
  const clock = { now: T0 };
  const unlock = createRestrictedUnlock(() => clock.now);
  const logged: PersonalLogEvent[] = [];
  const web = await startWeb({
    socket,
    admin: {} as Admin,
    log: { info: (e) => logged.push(e), warn: (e) => logged.push(e), error: (e) => logged.push(e) },
    client: await loadClient(join(tmpdir(), "pi-web-no-client-here")),
    tailscale: TS,
    now: () => clock.now,
    nameHoldsMs: 0,
    relaysMs: 0,
    restricted: { path: restricted, unlock },
  });
  servers.push(web);
  const device = authenticator();
  const code = await control(socket, "register");
  const options = await post(socket, "/passkey/register-options", { code });
  const made = await post(socket, "/passkey/register", {
    code,
    ...registration(device, TS.host, challengeOf(options)),
  });
  expect(made.status).toBe(200);
  const cookie = ([made.headers["set-cookie"] ?? []].flat()[0] ?? "").split(";")[0] ?? "";
  return { socket, restricted, recovery, unlock, clock, logged, device, cookie };
}

const challengeOf = (answer: Answer): string => (JSON.parse(answer.body) as { challenge: string }).challenge;

// One unlock: its options, then the assertion (changed by `options`) with what `extra` adds.
async function unlockWith(
  s: Started,
  extra: { prf?: string; recovery?: string },
  options: Parameters<typeof assertion>[3] = {},
): Promise<{ answer: Answer; body: Record<string, unknown> }> {
  const offered = await post(s.socket, "/restricted/unlock-options", {}, s.cookie);
  expect(offered.status).toBe(200);
  const body = { ...assertion(s.device, TS.host, challengeOf(offered), options), ...extra };
  return { answer: await post(s.socket, "/restricted/unlock", body, s.cookie), body };
}

const held = (s: Started): string[] => [...s.unlock.held().keys()].sort();

describe("the restricted keys' unlock on the dashboard", () => {
  it("is asked within a session only, and offers the passkey with the file's PRF salt", async () => {
    const s = await started();
    for (const path of ["/restricted/unlock-options", "/restricted/unlock", "/restricted/status", "/restricted/lock"])
      expect(await post(s.socket, path, {}), path).toMatchObject({ status: 401, body: "" });
    const offered = await post(s.socket, "/restricted/unlock-options", {}, s.cookie);
    const file = JSON.parse(await readFile(s.restricted, "utf8")) as { prfSalt: string };
    expect(JSON.parse(offered.body)).toMatchObject({
      rpId: TS.host,
      allowCredentials: [{ type: "public-key", id: s.device.id.toString("base64url") }],
      userVerification: "required",
      prfSalt: file.prfSalt,
    });
    expect(JSON.parse((await post(s.socket, "/restricted/status", {}, s.cookie)).body)).toEqual({
      state: "locked",
      passkey: false,
    });
  });

  it("opens the keys for the window by the recovery secret once, then by the passkey's PRF output, and locks again", async () => {
    const s = await started();
    const prf = randomBytes(32).toString("base64url");
    // No PRF slot yet: the PRF output alone opens nothing.
    expect((await unlockWith(s, { prf })).answer).toMatchObject({ status: 401, body: "" });
    expect(held(s)).toEqual([]);

    // The recovery secret opens them, and gives this passkey its PRF slot.
    const first = await unlockWith(s, { prf, recovery: s.recovery });
    expect(first.answer.status).toBe(200);
    expect(JSON.parse(first.answer.body)).toEqual({
      state: "unlocked",
      until: new Date(T0.getTime() + UNLOCK_WINDOW_MS).toISOString(),
    });
    expect(held(s)).toEqual(LOCKED);
    const file = JSON.parse(await readFile(s.restricted, "utf8")) as { prf?: { credential: string } };
    expect(file.prf?.credential).toBe(s.device.id.toString("base64url"));
    // The same assertion again: its challenge is spent.
    expect(await post(s.socket, "/restricted/unlock", first.body, s.cookie)).toMatchObject({ status: 401 });

    // The owner locks them.
    expect(JSON.parse((await post(s.socket, "/restricted/lock", {}, s.cookie)).body)).toEqual({
      state: "locked",
      passkey: true,
    });
    expect(held(s)).toEqual([]);

    // From now the PRF output alone opens them, for the window and no longer.
    expect((await unlockWith(s, { prf })).answer.status).toBe(200);
    expect(held(s)).toEqual(LOCKED);
    expect(JSON.parse((await post(s.socket, "/restricted/status", {}, s.cookie)).body)).toMatchObject({
      state: "unlocked",
    });
    s.clock.now = new Date(T0.getTime() + UNLOCK_WINDOW_MS - 1);
    expect(held(s)).toEqual(LOCKED);
    s.clock.now = new Date(T0.getTime() + UNLOCK_WINDOW_MS);
    expect(held(s)).toEqual([]);

    // Nothing of a secret reaches the log.
    const text = JSON.stringify(s.logged);
    for (const secret of [prf, s.recovery]) expect(text).not.toContain(secret);
    expect(s.logged.filter((one) => one.event === "restricted_unlocked")).toHaveLength(2);
  });

  it("refuses a wrong secret, a forged assertion, a wrong origin or rp id, no user verification, a falling count and a replayed challenge", async () => {
    const s = await started();
    const prf = randomBytes(32).toString("base64url");
    // A wrong recovery secret, and one that is not a secret's shape.
    expect((await unlockWith(s, { recovery: randomBytes(32).toString("base64url") })).answer.status).toBe(401);
    expect((await unlockWith(s, { recovery: "short" })).answer.status).toBe(401);
    expect((await unlockWith(s, { recovery: "not base64url!" })).answer.status).toBe(400);
    // The right secret under a forged assertion opens nothing.
    for (const forged of [
      { origin: "https://evil.example" },
      { rpId: "evil.example" },
      { flags: UP },
      { signer: authenticator().privateKey },
    ])
      expect((await unlockWith(s, { recovery: s.recovery }, forged)).answer, JSON.stringify(forged)).toMatchObject({
        status: 401,
      });
    expect(held(s)).toEqual([]);
    // A count that rises opens; one that falls after it, and a challenge never issued, do not.
    expect((await unlockWith(s, { prf, recovery: s.recovery }, { count: 5 })).answer.status).toBe(200);
    s.unlock.lock();
    expect((await unlockWith(s, { prf }, { count: 4 })).answer.status).toBe(401);
    expect(
      await post(
        s.socket,
        "/restricted/unlock",
        { ...assertion(s.device, TS.host, "A".repeat(43), { count: 9 }), prf },
        s.cookie,
      ),
    ).toMatchObject({ status: 401 });
    // Another PRF output for this passkey opens nothing.
    expect((await unlockWith(s, { prf: randomBytes(32).toString("base64url") }, { count: 10 })).answer.status).toBe(
      401,
    );
    expect(held(s)).toEqual([]);
    // From another origin, the step is refused before anything is read.
    expect(await post(s.socket, "/restricted/unlock-options", {}, s.cookie, "https://evil.example")).toMatchObject({
      status: 403,
    });
  });

  it("answers no_restricted_lock when no wrapped file is set up, and opens nothing", async () => {
    const s = await started();
    await rm(s.restricted);
    expect(await post(s.socket, "/restricted/unlock-options", {}, s.cookie)).toMatchObject({
      status: 404,
      body: '{"refused":"no_restricted_lock"}',
    });
    expect(JSON.parse((await post(s.socket, "/restricted/status", {}, s.cookie)).body)).toEqual({ state: "none" });
  });
});
