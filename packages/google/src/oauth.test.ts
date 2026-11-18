import { type AddressInfo, connect, createServer, Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_SCOPES, type GoogleDeps, GoogleError, type GrantKind, grantedScopesFor } from "./http.ts";
import {
  buildAuthUrl,
  exchangeCode,
  listenForCode,
  MAIL_REFRESH_ACCEPTS_NO_SCOPE,
  pkceChallenge,
  pkcePair,
  tokenSource,
} from "./oauth.ts";

// Every value here is made up. The token endpoint is a fake fetch; the listener tests use
// real sockets on 127.0.0.1 and nothing else.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const client = { clientId: "fake-client-id.apps.example.test", clientSecret: "fake-client-secret" };
const exchange = {
  grant: "mail" as const,
  ...client,
  code: "fake-code",
  redirectUri: "http://127.0.0.1:53682/",
  codeVerifier: "fake-verifier",
};
const [MAIL, CALENDAR] = GOOGLE_SCOPES;
// The scope a token granted before mail was read in full holds.
const METADATA = "https://www.googleapis.com/auth/gmail.metadata";
const DRIVE_METADATA = "https://www.googleapis.com/auth/drive.metadata.readonly";
const DOCUMENTS = "https://www.googleapis.com/auth/documents.readonly";

type Answer = { status: number; body?: unknown } | Error;
type Call = { url: string; init: RequestInit };

function fake(answers: Answer[], start = Date.parse("2026-03-10T12:00:00.000Z")) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const clock = { now: start };
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const answer = answers[calls.length - 1];
    if (answer === undefined) throw new Error("the fake has no answer left");
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  };
  const deps: GoogleDeps = {
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
    now: () => clock.now,
    random: () => 0.5,
    timeoutMs: 1000,
  };
  return { calls, sleeps, clock, deps };
}

const grant = (scope: string, extra: Record<string, unknown> = { refresh_token: "fake-refresh-token" }): Answer => ({
  status: 200,
  body: { access_token: "fake-access-token", expires_in: 3599, token_type: "Bearer", scope, ...extra },
});
const access = (token: string, expiresIn = 3600): Answer => ({
  status: 200,
  body: { access_token: token, expires_in: expiresIn, token_type: "Bearer", scope: `${MAIL} ${CALENDAR}` },
});
const form = (call: Call | undefined): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(String(call?.init.body)));

async function failure(promise: Promise<unknown>): Promise<GoogleError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GoogleError) return error;
    throw error;
  }
  throw new Error("it did not fail");
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

// True once nothing listens on 127.0.0.1 at that port: a second listener can take it.
const isFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
const portOf = (redirectUri: string): number => Number(new URL(redirectUri).port);
const closed = (redirectUri: string): Promise<void> =>
  vi.waitFor(async () => expect(await isFree(portOf(redirectUri))).toBe(true));
const pending = Symbol("pending");
const settled = (promise: Promise<string>): Promise<string | typeof pending> =>
  Promise.race([promise, new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 20))]);

// A second local peer that connects and sends nothing. `ended` settles when the server ends
// the connection, or with "open" if it has not within four seconds.
async function idlePeer(redirectUri: string): Promise<{ socket: Socket; ended: Promise<"closed" | "open"> }> {
  const socket = connect(portOf(redirectUri), "127.0.0.1");
  socket.on("error", () => {});
  const ended = new Promise<"closed" | "open">((resolve) => {
    socket.once("close", () => resolve("closed"));
    setTimeout(() => resolve("open"), 4_000);
  });
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  return { socket, ended };
}

afterEach(() => void vi.restoreAllMocks());

describe("the authorization URL and PKCE", () => {
  it("the URL carries both scopes, offline access, consent, state and S256", () => {
    const url = new URL(
      buildAuthUrl({
        grant: "mail",
        clientId: client.clientId,
        redirectUri: exchange.redirectUri,
        state: "fake-state",
        codeChallenge: "fake-challenge",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: exchange.redirectUri,
      scope: `${MAIL} ${CALENDAR}`,
      state: "fake-state",
      code_challenge: "fake-challenge",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly",
    );
  });

  it("the challenge for RFC 7636's sample verifier is its sample challenge", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const pair = pkcePair();
    // 32 random bytes as base64url, with no padding.
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(pkceChallenge(pair.verifier));
    expect(pkcePair().verifier).not.toBe(pair.verifier);
  });
});

describe("the code exchange", () => {
  it("the exchange sends the code, verifier, redirect URI and client", async () => {
    const { calls, deps } = fake([grant(`${MAIL} ${CALENDAR}`)]);
    await exchangeCode(exchange, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TOKEN_URL);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(typeof calls[0]?.init.body).toBe("string");
    expect(form(calls[0])).toEqual({
      grant_type: "authorization_code",
      code: "fake-code",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: exchange.redirectUri,
      code_verifier: "fake-verifier",
    });

    // A write: an answer a read would retry is final after one call.
    const limited = fake([{ status: 429 }, grant(`${MAIL} ${CALENDAR}`)]);
    const error = await failure(exchangeCode(exchange, limited.deps));
    expect(error.code).toBe("rate_limited");
    expect(limited.calls).toHaveLength(1);
    expect(limited.sleeps).toEqual([]);
  });

  it("a grant of exactly both scopes returns the refresh token", async () => {
    for (const scope of [`${MAIL} ${CALENDAR}`, `${CALENDAR} ${MAIL}`]) {
      const { deps } = fake([grant(scope)]);
      expect(await exchangeCode(exchange, deps)).toEqual({ refreshToken: "fake-refresh-token" });
    }
  });

  it("a grant with a modify, send, compose or full-mail scope is refused with scope_mismatch", async () => {
    const broader = [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://mail.google.com/",
    ];
    for (const scope of broader) {
      const { deps } = fake([grant(`${MAIL} ${CALENDAR} ${scope}`)]);
      expect((await failure(exchangeCode(exchange, deps))).code).toBe("scope_mismatch");
    }
    // The positive control: the same answer with the two scopes alone is accepted.
    const { deps } = fake([grant(`${MAIL} ${CALENDAR}`)]);
    expect(await exchangeCode(exchange, deps)).toEqual({ refreshToken: "fake-refresh-token" });
  });

  it("a grant of gmail.metadata in place of gmail.readonly is refused with scope_mismatch", async () => {
    // In its place, and beside it.
    for (const scope of [`${METADATA} ${CALENDAR}`, `${CALENDAR} ${METADATA}`, `${MAIL} ${CALENDAR} ${METADATA}`]) {
      const { calls, deps } = fake([grant(scope)]);
      const error = await failure(exchangeCode(exchange, deps));
      expect(error.code, scope).toBe("scope_mismatch");
      expect(error.status).toBeUndefined();
      expect(calls).toHaveLength(1);
    }
    // The positive control: the same answer with gmail.readonly is accepted.
    const { deps } = fake([grant(`${MAIL} ${CALENDAR}`)]);
    expect(await exchangeCode(exchange, deps)).toEqual({ refreshToken: "fake-refresh-token" });
  });

  it("a grant that names a scope twice is the same grant", async () => {
    for (const scope of [
      `${MAIL} ${CALENDAR} ${MAIL}`,
      `${CALENDAR} ${CALENDAR} ${MAIL}`,
      `${MAIL} ${MAIL} ${CALENDAR} ${CALENDAR}`,
    ]) {
      const exchanged = fake([grant(scope)]);
      expect(await exchangeCode(exchange, exchanged.deps), scope).toEqual({ refreshToken: "fake-refresh-token" });
      const refreshed = fake([grant(scope, {})]);
      expect(
        await tokenSource(
          { grant: "mail", ...client, refreshToken: "fake-refresh-token" },
          refreshed.deps,
        ).accessToken(),
        scope,
      ).toBe("fake-access-token");
    }
    // A scope named twice does not stand in for one that is missing.
    for (const scope of [`${MAIL} ${MAIL}`, `${CALENDAR} ${CALENDAR}`]) {
      const exchanged = fake([grant(scope)]);
      expect((await failure(exchangeCode(exchange, exchanged.deps))).code, scope).toBe("scope_mismatch");
      const refreshed = fake([grant(scope, {})]);
      expect(
        (
          await failure(
            tokenSource({ grant: "mail", ...client, refreshToken: "fake-refresh-token" }, refreshed.deps).accessToken(),
          )
        ).code,
        scope,
      ).toBe("scope_mismatch");
    }
  });

  it("a grant missing the calendar scope is refused with scope_mismatch", async () => {
    for (const body of [
      grant(MAIL),
      grant(CALENDAR),
      grant(""),
      { status: 200, body: { refresh_token: "fake-refresh-token" } },
    ]) {
      const { deps } = fake([body]);
      expect((await failure(exchangeCode(exchange, deps))).code).toBe("scope_mismatch");
    }
  });

  it("a grant of two scopes, one of them wrong, is refused with scope_mismatch", async () => {
    for (const scope of [
      `${MAIL} ${METADATA}`,
      `${CALENDAR} https://www.googleapis.com/auth/calendar.readonly`,
      `${MAIL} ${MAIL}`,
      `${MAIL}  ${CALENDAR}`,
    ]) {
      const { deps } = fake([grant(scope)]);
      expect((await failure(exchangeCode(exchange, deps))).code, scope).toBe("scope_mismatch");
    }
  });

  it("an answer without refresh_token fails oauth_failed", async () => {
    for (const extra of [{}, { refresh_token: "" }, { refresh_token: 7 }]) {
      const { deps } = fake([grant(`${MAIL} ${CALENDAR}`, extra)]);
      expect((await failure(exchangeCode(exchange, deps))).code).toBe("oauth_failed");
    }
  });
});

describe("the loopback listener", () => {
  it("the listener binds 127.0.0.1 on the given port, and redirectUri names it", async () => {
    const port = await freePort();
    const listen = vi.spyOn(Server.prototype, "listen");
    const { redirectUri, code } = await listenForCode("fake-state", port, { timeoutMs: 5000 });
    expect(redirectUri).toBe(`http://127.0.0.1:${port}/`);
    // The address the listener's own server reports: the loopback address, and no other.
    expect(listen).toHaveBeenCalledTimes(1);
    const server = listen.mock.contexts[0] as Server;
    expect(server.address()).toEqual({ address: "127.0.0.1", family: "IPv4", port });
    expect((await fetch(`${redirectUri}?state=fake-state&code=fake-code`)).status).toBe(200);
    expect(await code).toBe("fake-code");
  });

  it("without a port it binds a free one", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const first = await listenForCode("fake-state", undefined, { timeoutMs: 5000 });
    const second = await listenForCode("fake-state", undefined, { timeoutMs: 5000 });
    for (const [index, { redirectUri }] of [first, second].entries()) {
      expect((listen.mock.contexts[index] as Server).address()).toEqual({
        address: "127.0.0.1",
        family: "IPv4",
        port: portOf(redirectUri),
      });
    }
    expect(first.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*\/$/);
    expect(second.redirectUri).not.toBe(first.redirectUri);
    for (const { redirectUri, code } of [first, second]) {
      await fetch(`${redirectUri}?state=fake-state&code=fake-code`);
      expect(await code).toBe("fake-code");
    }
  });

  it("a wrong state and another path are answered 400 and the listener keeps waiting", async () => {
    const { redirectUri, code } = await listenForCode("fake-state", undefined, { timeoutMs: 5000 });
    const refused = [
      `${redirectUri}?state=another-state&code=fake-code`,
      `${redirectUri}?state=another-state&error=access_denied`,
      `${redirectUri}callback?state=fake-state&code=fake-code`,
      `${redirectUri}?code=fake-code`,
      `${redirectUri}?state=fake-state`,
      `${redirectUri}?state=fake-state&code=`,
      redirectUri,
    ];
    for (const url of refused) {
      const response = await fetch(url);
      expect(response.status, url).toBe(400);
      expect(await response.text()).toBe("");
    }
    expect((await fetch(`${redirectUri}?state=fake-state&code=fake-code`, { method: "POST" })).status).toBe(400);
    expect(await settled(code)).toBe(pending);

    // The positive control: it was waiting all along.
    expect((await fetch(`${redirectUri}?state=fake-state&code=fake-code`)).status).toBe(200);
    expect(await code).toBe("fake-code");
  });

  it("a state that is a prefix of the right one, in another case, longer or empty is answered 400 and the listener keeps waiting", async () => {
    const { redirectUri, code } = await listenForCode("Fake-State-123", undefined, { timeoutMs: 5000 });
    for (const state of ["Fake-State", "F", "fake-state-123", "FAKE-STATE-123", "Fake-State-1234", ""]) {
      for (const rest of ["code=fake-code", "error=access_denied"]) {
        const response = await fetch(`${redirectUri}?state=${state}&${rest}`);
        expect(response.status, state).toBe(400);
      }
    }
    expect(await settled(code)).toBe(pending);

    // An empty state is no match even for a listener that was given one.
    const blank = await listenForCode("", undefined, { timeoutMs: 5000 });
    expect((await fetch(`${blank.redirectUri}?code=fake-code`)).status).toBe(400);
    expect(await settled(blank.code)).toBe(pending);
    expect((await fetch(`${blank.redirectUri}?state=&code=fake-code`)).status).toBe(200);
    await blank.code;

    // The positive control: the whole state, exactly.
    expect((await fetch(`${redirectUri}?state=Fake-State-123&code=fake-code`)).status).toBe(200);
    expect(await code).toBe("fake-code");
  });

  it("a request with both an error and a code rejects, and the listener closes", async () => {
    for (const query of [
      "state=fake-state&code=fake-code&error=access_denied",
      "state=fake-state&error=access_denied&code=fake-code",
      "state=fake-state&error=&code=fake-code",
    ]) {
      const { redirectUri, code } = await listenForCode("fake-state", undefined, { timeoutMs: 5000 });
      expect((await fetch(`${redirectUri}?${query}`)).status).toBe(200);
      expect((await failure(code)).code, query).toBe("oauth_failed");
      await closed(redirectUri);
    }
  });

  it("the timer is cleared once the code settles or is refused", async () => {
    for (const query of ["state=fake-state&code=fake-code", "state=fake-state&error=access_denied"]) {
      const set = vi.spyOn(globalThis, "setTimeout");
      const clear = vi.spyOn(globalThis, "clearTimeout");
      const { redirectUri, code } = await listenForCode("fake-state", undefined, { timeoutMs: 54_321 });
      const timers = set.mock.results
        .filter((_result, index) => set.mock.calls[index]?.[1] === 54_321)
        .map((result) => result.value as NodeJS.Timeout);
      expect(timers).toHaveLength(1);
      expect(clear).not.toHaveBeenCalledWith(timers[0]);
      await fetch(`${redirectUri}?${query}`);
      await code.catch(() => {});
      // Nothing is left to fire or to hold the process open.
      expect(clear).toHaveBeenCalledWith(timers[0]);
      vi.restoreAllMocks();
    }
  });

  it("an idle connection is ended when the code settles, when it is refused, and at the timeout", async () => {
    for (const query of ["state=fake-state&code=fake-code", "state=fake-state&error=access_denied"]) {
      const { redirectUri, code } = await listenForCode("fake-state", undefined, { timeoutMs: 5000 });
      const peer = await idlePeer(redirectUri);
      // A request that does not settle leaves the peer connected.
      expect((await fetch(redirectUri)).status).toBe(400);
      expect(peer.socket.destroyed).toBe(false);
      const response = await fetch(`${redirectUri}?${query}`);
      expect(response.status).toBe(200);
      // The page still arrives whole before the connections end.
      expect(await response.text()).toContain("Finished");
      await code.catch(() => {});
      expect(await peer.ended, query).toBe("closed");
    }

    const { redirectUri, code } = await listenForCode("fake-state", undefined, { timeoutMs: 40 });
    const peer = await idlePeer(redirectUri);
    expect((await failure(code)).code).toBe("oauth_failed");
    expect(await peer.ended).toBe("closed");
  });

  it("the matching state settles code, and the listener closes", async () => {
    const { redirectUri, code } = await listenForCode("fake-state", undefined, { timeoutMs: 5000 });
    const response = await fetch(`${redirectUri}?state=fake-state&code=fake-code-4%2Fabc&scope=ignored`);
    expect(response.status).toBe(200);
    const page = await response.text();
    // A fixed page that echoes nothing.
    expect(page).not.toContain("fake");
    expect(page).not.toContain("ignored");
    expect(await code).toBe("fake-code-4/abc");
    await closed(redirectUri);
  });

  it("an error= with the matching state rejects oauth_failed, and the listener closes", async () => {
    const { redirectUri, code } = await listenForCode("fake-state", undefined, { timeoutMs: 5000 });
    const response = await fetch(`${redirectUri}?state=fake-state&error=access_denied_fake`);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("fake");
    const error = await failure(code);
    expect(error.code).toBe("oauth_failed");
    expect(error.status).toBeUndefined();
    await closed(redirectUri);
  });

  it("with no code, the listener closes at its timeout and rejects oauth_failed", async () => {
    const { redirectUri, code } = await listenForCode("fake-state", undefined, { timeoutMs: 40 });
    // It is still listening before the timeout.
    expect((await fetch(redirectUri)).status).toBe(400);
    expect((await failure(code)).code).toBe("oauth_failed");
    await closed(redirectUri);
  });

  it("a port that is taken fails oauth_failed", async () => {
    const taken = await listenForCode("fake-state", undefined, { timeoutMs: 5000 });
    expect((await failure(listenForCode("fake-state", portOf(taken.redirectUri), { timeoutMs: 5000 }))).code).toBe(
      "oauth_failed",
    );
    await fetch(`${taken.redirectUri}?state=fake-state&code=fake-code`);
    await taken.code;
  });
});

describe("the token source", () => {
  const source = { grant: "mail" as const, ...client, refreshToken: "fake-refresh-token" };

  it("the access token is reused until a minute before expiry, then refreshed", async () => {
    const { calls, clock, deps } = fake([access("fake-access-token-1"), access("fake-access-token-2")]);
    const tokens = tokenSource(source, deps);
    const start = clock.now;
    expect(await tokens.accessToken()).toBe("fake-access-token-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TOKEN_URL);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(form(calls[0])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "fake-refresh-token",
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });

    clock.now = start + 3_540_000 - 1;
    expect(await tokens.accessToken()).toBe("fake-access-token-1");
    expect(calls).toHaveLength(1);

    clock.now = start + 3_540_000;
    expect(await tokens.accessToken()).toBe("fake-access-token-2");
    expect(calls).toHaveLength(2);
  });

  it("requests that need a token at once share one refresh, and a failed one is not kept", async () => {
    const { calls, deps } = fake([
      access("fake-access-token-1"),
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
      access("fake-access-token-2"),
    ]);
    const tokens = tokenSource(source, deps);
    expect(
      await Promise.all([tokens.accessToken(), tokens.accessToken(), tokens.accessToken(), tokens.accessToken()]),
    ).toEqual(Array.from({ length: 4 }, () => "fake-access-token-1"));
    expect(calls).toHaveLength(1);
    // A refresh that fails fails every request waiting on it, and the next one asks again.
    tokens.invalidate();
    const failed = await Promise.allSettled([tokens.accessToken(), tokens.accessToken()]);
    expect(failed.map((one) => one.status)).toEqual(["rejected", "rejected"]);
    expect(calls).toHaveLength(6);
    expect(await tokens.accessToken()).toBe("fake-access-token-2");
  });

  it("invalidate forces a refresh", async () => {
    const { calls, deps } = fake([access("fake-access-token-1"), access("fake-access-token-2")]);
    const tokens = tokenSource(source, deps);
    expect(await tokens.accessToken()).toBe("fake-access-token-1");
    expect(await tokens.accessToken()).toBe("fake-access-token-1");
    expect(calls).toHaveLength(1);
    tokens.invalidate();
    expect(await tokens.accessToken()).toBe("fake-access-token-2");
    expect(calls).toHaveLength(2);
  });

  it("a refresh answer whose scope is not the set fails scope_mismatch, and one with no scope is accepted while the deploy gate holds", async () => {
    const refreshed = (scope: unknown): Answer => ({
      status: 200,
      body: { access_token: "fake-access-token-1", expires_in: 3600, token_type: "Bearer", scope },
    });
    // Another grant, a broader one, a narrower one, and a scope that is no string.
    const refused = [
      `${METADATA} ${CALENDAR}`,
      `${MAIL} ${CALENDAR} https://www.googleapis.com/auth/gmail.modify`,
      `${MAIL} ${CALENDAR} ${METADATA}`,
      MAIL,
      CALENDAR,
      "",
      `${MAIL}  ${CALENDAR}`,
      7,
      null,
    ];
    for (const scope of refused) {
      const { calls, sleeps, deps } = fake([refreshed(scope), refreshed(scope), access("fake-access-token-2")]);
      const tokens = tokenSource(source, deps);
      const error = await failure(tokens.accessToken());
      expect(error.code, String(scope)).toBe("scope_mismatch");
      expect(error.status).toBeUndefined();
      // Not retried, and the token is not kept: the next call asks again.
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
      expect((await failure(tokens.accessToken())).code).toBe("scope_mismatch");
      expect(calls).toHaveLength(2);
    }

    // The set itself, in either order, is accepted.
    for (const scope of [`${MAIL} ${CALENDAR}`, `${CALENDAR} ${MAIL}`]) {
      const { calls, deps } = fake([refreshed(scope)]);
      expect(await tokenSource(source, deps).accessToken(), scope).toBe("fake-access-token-1");
      expect(calls).toHaveLength(1);
    }
    // An answer with no scope at all is accepted for mail until the live check shows Google's
    // refresh answer carries the exact set; then it is refused.
    const bare = fake([
      { status: 200, body: { access_token: "fake-access-token-1", expires_in: 3600, token_type: "Bearer" } },
    ]);
    const outcome = await tokenSource(source, bare.deps)
      .accessToken()
      .catch((error: unknown) => (error instanceof GoogleError ? error.code : "threw"));
    expect(outcome).toBe(MAIL_REFRESH_ACCEPTS_NO_SCOPE ? "fake-access-token-1" : "scope_mismatch");
    expect(bare.calls).toHaveLength(1);
  });

  it("invalid_grant fails oauth_failed after one call", async () => {
    for (const status of [400, 401]) {
      const refresh = fake([
        { status, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } },
        access("fake-access-token-1"),
      ]);
      const refused = await failure(tokenSource(source, refresh.deps).accessToken());
      expect(refused.code).toBe("oauth_failed");
      expect(refused.status).toBe(status);
      expect(refresh.calls).toHaveLength(1);
      expect(refresh.sleeps).toEqual([]);

      const code = fake([{ status, body: { error: "invalid_grant" } }, grant(`${MAIL} ${CALENDAR}`)]);
      const exchanged = await failure(exchangeCode(exchange, code.deps));
      expect(exchanged.code).toBe("oauth_failed");
      expect(exchanged.status).toBe(status);
      expect(code.calls).toHaveLength(1);
    }
  });

  it("a refresh is retried as a read is, and a code exchange is sent once", async () => {
    for (const [answer, code] of [
      [{ status: 503 }, "unavailable"],
      [new Error("socket hang up"), "unavailable"],
      [{ status: 429 }, "rate_limited"],
    ] as const) {
      // A refresh changes nothing at Google: one failed attempt is followed by another.
      const refresh = fake([answer, access("fake-access-token-1")]);
      expect(await tokenSource(source, refresh.deps).accessToken()).toBe("fake-access-token-1");
      expect(refresh.calls).toHaveLength(2);
      expect(refresh.sleeps).toEqual([750]);
      // Every attempt is the same form POST.
      for (const call of refresh.calls)
        expect([call.url, call.init.method, form(call).grant_type]).toEqual([TOKEN_URL, "POST", "refresh_token"]);

      // Five attempts in all, with backoff, then its own code. The next call tries again.
      const down = fake([answer, answer, answer, answer, answer, access("fake-access-token-2")]);
      const tokens = tokenSource(source, down.deps);
      expect((await failure(tokens.accessToken())).code).toBe(code);
      expect(down.calls).toHaveLength(5);
      expect(down.sleeps).toEqual([750, 1500, 3000, 6000]);
      expect(await tokens.accessToken()).toBe("fake-access-token-2");

      // A code can be exchanged once only: the exchange is not sent again.
      const exchanged = fake([answer, grant(`${MAIL} ${CALENDAR}`)]);
      expect((await failure(exchangeCode(exchange, exchanged.deps))).code).toBe(code);
      expect(exchanged.calls).toHaveLength(1);
      expect(exchanged.sleeps).toEqual([]);
    }
  });

  it("a token request answered 403 or 404 keeps its own code", async () => {
    for (const [status, code] of [
      [403, "forbidden"],
      [404, "not_found"],
      [410, "not_found"],
      [409, "bad_response"],
    ] as const) {
      const refresh = fake([{ status, body: { error: "fake_error" } }]);
      const refused = await failure(tokenSource(source, refresh.deps).accessToken());
      expect([refused.code, refused.status]).toEqual([code, status]);
      expect(refresh.calls).toHaveLength(1);

      const exchanged = fake([{ status, body: { error: "fake_error" } }]);
      const error = await failure(exchangeCode(exchange, exchanged.deps));
      expect([error.code, error.status]).toEqual([code, status]);
      expect(exchanged.calls).toHaveLength(1);
    }
  });

  it("the token request's deadline is the timeout from deps", { timeout: 2000 }, async () => {
    // A fetch that answers only when its signal aborts: with 5 ms from deps it fails at once,
    // and with any default it would outlast this test.
    const hang: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const deps: GoogleDeps = { ...fake([]).deps, fetch: hang, timeoutMs: 5 };
    expect((await failure(tokenSource(source, deps).accessToken())).code).toBe("unavailable");
    expect((await failure(exchangeCode(exchange, deps))).code).toBe("unavailable");
  });

  it("a refresh answer without a token or a lifetime fails bad_response", async () => {
    for (const body of [
      { expires_in: 3600 },
      { access_token: "fake-access-token-1" },
      { access_token: "", expires_in: 3600 },
      ["fake"],
    ]) {
      const { deps } = fake([{ status: 200, body }]);
      expect((await failure(tokenSource(source, deps).accessToken())).code).toBe("bad_response");
    }
  });
});

describe("the grants", () => {
  const SEND = "https://www.googleapis.com/auth/gmail.send";
  const USERINFO = "https://www.googleapis.com/auth/userinfo.email";
  const ADDRESS = "owner@quinn.test";
  // An id token as the token endpoint returns one: three base64url parts, the middle one a JSON
  // payload. Nothing checks the signature.
  const idToken = (payload: unknown): string =>
    ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "fake-signature"].join(".");
  const verified = idToken({ email: ADDRESS, email_verified: true, sub: "fake-subject" });
  const sendExchange = { ...exchange, grant: "send" as const, expectedAddress: ADDRESS };
  const sendGrant = (scope: string, extra: Record<string, unknown> = {}): Answer =>
    grant(scope, { refresh_token: "fake-refresh-token", id_token: verified, ...extra });
  const SEND_SET = `${SEND} openid ${USERINFO}`;
  const refreshed = (scope?: string): Answer => ({
    status: 200,
    body: {
      access_token: "fake-access-token",
      expires_in: 3600,
      token_type: "Bearer",
      ...(scope === undefined ? {} : { scope }),
    },
  });
  const source = (grant: GrantKind) => ({ grant, ...client, refreshToken: "fake-refresh-token" });

  it("a send grant of exactly grantedScopesFor('send') is accepted", async () => {
    for (const scope of [SEND_SET, `openid ${USERINFO} ${SEND}`, `${USERINFO} ${SEND} openid`]) {
      const { calls, deps } = fake([sendGrant(scope)]);
      expect(await exchangeCode(sendExchange, deps), scope).toEqual({ refreshToken: "fake-refresh-token" });
      expect(calls).toHaveLength(1);
      const refresh = fake([refreshed(scope)]);
      expect(await tokenSource(source("send"), refresh.deps).accessToken(), scope).toBe("fake-access-token");
    }
  });

  it("a send grant with a read scope beside them, one of gmail.send alone, and one of gmail.compose are refused with scope_mismatch", async () => {
    const refused = [
      `${SEND_SET} ${MAIL}`,
      `${SEND_SET} ${CALENDAR}`,
      SEND,
      `${SEND} openid`,
      "https://www.googleapis.com/auth/gmail.compose",
      `https://www.googleapis.com/auth/gmail.compose openid ${USERINFO}`,
    ];
    for (const scope of refused) {
      const { deps } = fake([sendGrant(scope)]);
      expect((await failure(exchangeCode(sendExchange, deps))).code, scope).toBe("scope_mismatch");
    }
  });

  it("for each grant, a token answer and a refresh answer whose scopes are not exactly grantedScopesFor of that grant, broader, narrower or other, are refused with scope_mismatch", async () => {
    for (const [grant_, other] of [
      ["mail", "send"],
      ["send", "mail"],
      ["drive", "mail"],
      ["mail", "drive"],
    ] as const) {
      const own = grantedScopesFor(grant_);
      const wrong = [
        [...own, "https://mail.google.com/"].join(" "),
        own.slice(1).join(" "),
        grantedScopesFor(other).join(" "),
        [...own, ...grantedScopesFor(other)].join(" "),
        "",
      ];
      // The requested form of the send grant's address scope is not the granted form.
      if (grant_ === "send") wrong.push(`${SEND} openid email`);
      for (const scope of wrong) {
        const asked = grant_ === "send" ? sendExchange : { ...exchange, grant: grant_ };
        const exchanged = fake([sendGrant(scope)]);
        expect((await failure(exchangeCode(asked, exchanged.deps))).code, `${grant_} ${scope}`).toBe("scope_mismatch");
        const refresh = fake([refreshed(scope)]);
        expect(
          (await failure(tokenSource(source(grant_), refresh.deps).accessToken())).code,
          `${grant_} ${scope}`,
        ).toBe("scope_mismatch");
      }
      // The positive control: the grant's own set.
      const refresh = fake([refreshed(own.join(" "))]);
      expect(await tokenSource(source(grant_), refresh.deps).accessToken()).toBe("fake-access-token");
    }
  });

  it("a send refresh answer that names no scope is refused, whatever the mail gate", async () => {
    const { calls, deps } = fake([refreshed()]);
    expect((await failure(tokenSource(source("send"), deps).accessToken())).code).toBe("scope_mismatch");
    expect(calls).toHaveLength(1);
  });

  it("a mail refresh answer with no scope stays accepted until the live Google check shows both lines yes", () => {
    // Flip this to false, and this test with it, once the live check shows
    // refresh_answer_carries_scope yes and refresh_scope_exact yes.
    expect(MAIL_REFRESH_ACCEPTS_NO_SCOPE).toBe(true);
  });

  it("a consent whose id token names another address is refused with wrong_account and returns no token", async () => {
    for (const email of ["other@quinn.test", "owner@quinn.test.example", "owner@quinn.tes", ""]) {
      const { calls, deps } = fake([sendGrant(SEND_SET, { id_token: idToken({ email, email_verified: true }) })]);
      const error = await failure(exchangeCode(sendExchange, deps));
      expect([error.code, error.status], email).toEqual(["wrong_account", undefined]);
      expect(calls).toHaveLength(1);
    }
  });

  it("one whose email_verified is false, or missing, is refused", async () => {
    for (const payload of [
      { email: ADDRESS, email_verified: false },
      { email: ADDRESS },
      { email: ADDRESS, email_verified: "true" },
      { email: ADDRESS, email_verified: 1 },
    ]) {
      const { deps } = fake([sendGrant(SEND_SET, { id_token: idToken(payload) })]);
      expect((await failure(exchangeCode(sendExchange, deps))).code, JSON.stringify(payload)).toBe("wrong_account");
    }
  });

  it("the address is compared without case", async () => {
    for (const [email, expectedAddress] of [
      ["Owner@Quinn.TEST", ADDRESS],
      [ADDRESS, "OWNER@quinn.test"],
    ] as const) {
      const { deps } = fake([sendGrant(SEND_SET, { id_token: idToken({ email, email_verified: true }) })]);
      expect(await exchangeCode({ ...sendExchange, expectedAddress }, deps)).toEqual({
        refreshToken: "fake-refresh-token",
      });
    }
  });

  it("an answer with no id_token, or one that does not decode, is refused with wrong_account", async () => {
    const unreadable = [
      undefined,
      "",
      7,
      "e30.e30",
      "e30.not-json.sig",
      `e30.${Buffer.from("[]").toString("base64url")}.sig`,
      `e30.${Buffer.from('"text"').toString("base64url")}.sig`,
      `${verified}.extra`,
    ];
    for (const id_token of unreadable) {
      const { deps } = fake([
        grant(SEND_SET, { refresh_token: "fake-refresh-token", ...(id_token === undefined ? {} : { id_token }) }),
      ]);
      expect((await failure(exchangeCode(sendExchange, deps))).code, String(id_token)).toBe("wrong_account");
    }
  });

  it("expectedAddress is required for send and refused for mail", async () => {
    const { expectedAddress: _address, ...bare } = sendExchange;
    for (const asked of [bare, { ...exchange, expectedAddress: ADDRESS }, { ...sendExchange, expectedAddress: "" }]) {
      const { calls, deps } = fake([sendGrant(SEND_SET)]);
      // Refused before the code is spent.
      expect((await failure(exchangeCode(asked as Parameters<typeof exchangeCode>[0], deps))).code).toBe("bad_request");
      expect(calls).toEqual([]);
    }
  });

  it("an answer without refresh_token fails oauth_failed, for the send grant too", async () => {
    for (const extra of [{ refresh_token: undefined }, { refresh_token: "" }, { refresh_token: 7 }]) {
      const { deps } = fake([sendGrant(SEND_SET, extra)]);
      expect((await failure(exchangeCode(sendExchange, deps))).code).toBe("oauth_failed");
    }
  });

  it("the authorization URL carries the grant's scopes, the login hint, the state and the challenge, and no include_granted_scopes", () => {
    const url = new URL(
      buildAuthUrl({
        grant: "send",
        clientId: client.clientId,
        redirectUri: exchange.redirectUri,
        state: "fake-state",
        codeChallenge: "fake-challenge",
        loginHint: ADDRESS,
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: exchange.redirectUri,
      scope: `${SEND} openid email`,
      state: "fake-state",
      code_challenge: "fake-challenge",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      login_hint: ADDRESS,
    });
    const mail = new URL(
      buildAuthUrl({
        grant: "mail",
        clientId: client.clientId,
        redirectUri: exchange.redirectUri,
        state: "fake-state",
        codeChallenge: "fake-challenge",
      }),
    );
    expect(mail.searchParams.get("scope")).toBe(`${MAIL} ${CALENDAR}`);
    const drive = new URL(
      buildAuthUrl({
        grant: "drive",
        clientId: client.clientId,
        redirectUri: exchange.redirectUri,
        state: "fake-state",
        codeChallenge: "fake-challenge",
      }),
    );
    expect(drive.searchParams.get("scope")).toBe(`${DRIVE_METADATA} ${DOCUMENTS}`);
    for (const one of [url, mail, drive]) expect(one.searchParams.has("include_granted_scopes")).toBe(false);
    expect(mail.searchParams.has("login_hint")).toBe(false);
  });

  describe("the Drive grant (GD R1)", () => {
    const driveExchange = { ...exchange, grant: "drive" as const };
    const DRIVE_SET = `${DRIVE_METADATA} ${DOCUMENTS}`;
    const refreshed = (scope?: string): Answer => ({
      status: 200,
      body: {
        access_token: "fake-access-token",
        expires_in: 3600,
        token_type: "Bearer",
        ...(scope === undefined ? {} : { scope }),
      },
    });
    const source = { grant: "drive" as const, ...client, refreshToken: "fake-refresh-token" };

    it("a Drive grant of exactly the two scopes is accepted", async () => {
      for (const scope of [DRIVE_SET, `${DOCUMENTS} ${DRIVE_METADATA}`]) {
        const { deps } = fake([grant(scope)]);
        expect(await exchangeCode(driveExchange, deps), scope).toEqual({ refreshToken: "fake-refresh-token" });
        const refresh = fake([refreshed(scope)]);
        expect(await tokenSource(source, refresh.deps).accessToken(), scope).toBe("fake-access-token");
      }
    });

    it("a Drive grant with drive.readonly, drive or drive.file is refused with scope_mismatch", async () => {
      for (const wider of ["drive.readonly", "drive", "drive.file"].map(
        (one) => `https://www.googleapis.com/auth/${one}`,
      )) {
        for (const scope of [`${DRIVE_SET} ${wider}`, `${wider} ${DOCUMENTS}`]) {
          const { deps } = fake([grant(scope)]);
          expect((await failure(exchangeCode(driveExchange, deps))).code, scope).toBe("scope_mismatch");
        }
      }
    });

    it("a Drive grant missing a scope is refused", async () => {
      for (const scope of [DRIVE_METADATA, DOCUMENTS, ""]) {
        const { deps } = fake([grant(scope)]);
        expect((await failure(exchangeCode(driveExchange, deps))).code, scope).toBe("scope_mismatch");
      }
    });

    it("a refresh answer whose scope is not the Drive set fails scope_mismatch", async () => {
      for (const scope of [`${MAIL} ${CALENDAR}`, DRIVE_METADATA, `${DRIVE_SET} ${MAIL}`, undefined]) {
        const { deps } = fake([refreshed(scope)]);
        expect((await failure(tokenSource(source, deps).accessToken())).code, String(scope)).toBe("scope_mismatch");
      }
      // The control: the Drive set.
      const { deps } = fake([refreshed(DRIVE_SET)]);
      expect(await tokenSource(source, deps).accessToken()).toBe("fake-access-token");
    });
  });
});

// The contacts grant.
describe("the contacts grant", () => {
  const CONTACTS = "https://www.googleapis.com/auth/contacts.readonly";
  const USERINFO = "https://www.googleapis.com/auth/userinfo.email";
  const ADDRESS = "owner@quinn.test";
  const idToken = (payload: unknown): string =>
    ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "fake-signature"].join(".");
  const verified = idToken({ email: ADDRESS, email_verified: true });
  const contactsExchange = { ...exchange, grant: "contacts" as const, expectedAddress: ADDRESS };
  const contactsGrant = (scope: string, extra: Record<string, unknown> = {}): Answer =>
    grant(scope, { refresh_token: "fake-refresh-token", id_token: verified, ...extra });
  const THREE = `openid ${USERINFO} ${CONTACTS}`;
  const refreshed = (scope: string): Answer => ({
    status: 200,
    body: { access_token: "fake-access-token", expires_in: 3600, token_type: "Bearer", scope },
  });

  it("a contacts token answer whose scope is exactly the three is accepted", async () => {
    for (const scope of [THREE, `${CONTACTS} openid ${USERINFO}`]) {
      const { deps } = fake([contactsGrant(scope)]);
      expect(await exchangeCode(contactsExchange, deps), scope).toEqual({ refreshToken: "fake-refresh-token" });
    }
  });

  it("one without the contacts scope, one with a mail scope beside the three, and one without openid are scope_mismatch", async () => {
    for (const scope of [
      `openid ${USERINFO}`,
      `${THREE} ${MAIL}`,
      `${USERINFO} ${CONTACTS}`,
      `${CONTACTS} openid email`,
      "",
    ]) {
      const { deps } = fake([contactsGrant(scope)]);
      expect((await failure(exchangeCode(contactsExchange, deps))).code, scope).toBe("scope_mismatch");
    }
  });

  it("an id token of another address, and an unverified one, are wrong_account", async () => {
    for (const payload of [
      { email: "other@quinn.test", email_verified: true },
      { email: ADDRESS, email_verified: false },
      { email: ADDRESS },
    ]) {
      const { calls, deps } = fake([contactsGrant(THREE, { id_token: idToken(payload) })]);
      expect((await failure(exchangeCode(contactsExchange, deps))).code, JSON.stringify(payload)).toBe("wrong_account");
      expect(calls).toHaveLength(1);
    }
  });

  it("the address is compared without case", async () => {
    const { deps } = fake([
      contactsGrant(THREE, { id_token: idToken({ email: "Owner@Quinn.TEST", email_verified: true }) }),
    ]);
    expect(await exchangeCode({ ...contactsExchange, expectedAddress: "OWNER@quinn.test" }, deps)).toEqual({
      refreshToken: "fake-refresh-token",
    });
  });

  it("expectedAddress is required for contacts, before the code is spent", async () => {
    const { expectedAddress: _address, ...bare } = contactsExchange;
    const { calls, deps } = fake([contactsGrant(THREE)]);
    expect((await failure(exchangeCode(bare as Parameters<typeof exchangeCode>[0], deps))).code).toBe("bad_request");
    expect(calls).toEqual([]);
  });

  it("a refresh answer for the contacts grant whose scope is not the three fails scope_mismatch", async () => {
    const source = { grant: "contacts" as const, ...client, refreshToken: "fake-refresh-token" };
    for (const scope of [`${MAIL} ${CALENDAR}`, `openid ${USERINFO}`, `${THREE} ${MAIL}`]) {
      const { deps } = fake([refreshed(scope)]);
      expect((await failure(tokenSource(source, deps).accessToken())).code, scope).toBe("scope_mismatch");
    }
    const none = fake([{ status: 200, body: { access_token: "fake-access-token", expires_in: 3600 } }]);
    expect((await failure(tokenSource(source, none.deps).accessToken())).code).toBe("scope_mismatch");
    const ok = fake([refreshed(THREE)]);
    expect(await tokenSource(source, ok.deps).accessToken()).toBe("fake-access-token");
  });

  it("the authorization URL for contacts carries the login hint and the three scopes", () => {
    const url = new URL(
      buildAuthUrl({
        grant: "contacts",
        clientId: client.clientId,
        redirectUri: exchange.redirectUri,
        state: "fake-state",
        codeChallenge: "fake-challenge",
        loginHint: ADDRESS,
      }),
    );
    expect(url.searchParams.get("scope")).toBe(`${CONTACTS} openid email`);
    expect(url.searchParams.get("login_hint")).toBe(ADDRESS);
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
    expect(grantedScopesFor("contacts")).toEqual(["openid", USERINFO, CONTACTS]);
  });
});
