import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { OAuthRegistration, PersonalOAuth } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { HttpRequest } from "./http.ts";
import { createRoutes, serveHttp } from "./http.ts";
import {
  allowedRedirect,
  blockKey,
  MAX_PENDING,
  MAX_PENDING_PER_ADDRESS,
  MAX_PENDING_PER_BLOCK,
  MAX_REGISTRATIONS,
  MAX_REGISTRATIONS_PER_BLOCK,
  MAX_REGISTRATIONS_TOTAL,
  MAX_WRONG_CODES,
  redirectMatches,
} from "./oauth.ts";
import { AT_ONCE, clientView, fakeLog, fakeProvider, NO_WORK, TOKEN } from "./test-support/fakes.ts";

// The store's own rules are tested against the database in
// packages/store/src/read/oauth.db.test.ts.

const BASE = "https://pi.example";
const HOST = "pi.example";
const RESOURCE = `${BASE}/mcp`;
const CHATGPT = "https://chatgpt.com/connector_platform_oauth_redirect";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const APPROVAL = "ABCD-EFGH-JKMN";
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const MINUTE = 60_000;

type Grant = { client: string; family: number; until: number; used: boolean; revoked: boolean; registration: string };

// `hashes` maps an OAuth access token's hash to its client, as policy.current_client() would find
// it.
function fakeStore(clock: () => number) {
  const registrations = new Map<string, OAuthRegistration & { client?: string }>();
  const approvals = new Map<string, { client: string; until: number; used: boolean }>();
  const codes = new Map<
    string,
    {
      registration: string;
      client: string;
      redirectUri: string;
      challenge: string;
      resource: string | null;
      until: number;
      used: boolean;
      family: number;
    }
  >();
  const tokens = new Map<string, Grant & { kind: "access" | "refresh" }>();
  const revokedClients = new Set<string>();
  let families = 0;
  const revoke = (family: number) => {
    for (const token of tokens.values()) if (token.family === family) token.revoked = true;
  };
  const issue = (from: Omit<Grant, "until" | "used" | "revoked">, access: string, refresh: string) => {
    tokens.set(access, { ...from, kind: "access", until: clock() + 60 * MINUTE, used: false, revoked: false });
    tokens.set(refresh, {
      ...from,
      kind: "refresh",
      until: clock() + 30 * 24 * 60 * MINUTE,
      used: false,
      revoked: false,
    });
  };
  const store: PersonalOAuth = {
    register: async (id, value) => {
      const unapproved = [...registrations].filter(([, one]) => one.client === undefined);
      if (unapproved.length >= 100) registrations.delete(unapproved[0]?.[0] ?? "");
      registrations.set(id, { ...value });
    },
    registration: async (id) => {
      const one = registrations.get(id);
      return one === undefined
        ? null
        : { redirectUris: one.redirectUris, clientName: one.clientName, fingerprint: `FP${id.slice(3, 5)}-PRNT` };
    },
    authorize: async ({ registration, approvalHash, codeHash, redirectUri, challenge, resource }) => {
      const approval = approvals.get(approvalHash);
      const one = registrations.get(registration);
      if (
        approval === undefined ||
        approval.used ||
        approval.until <= clock() ||
        revokedClients.has(approval.client) ||
        one === undefined
      )
        return false;
      approval.used = true;
      one.client = approval.client;
      codes.set(codeHash, {
        registration,
        client: approval.client,
        redirectUri,
        challenge,
        resource,
        until: clock() + 5 * MINUTE,
        used: false,
        family: (families += 1),
      });
      return true;
    },
    exchange: async ({ registration, codeHash, challenge, redirectUri, resource, accessHash, refreshHash }) => {
      const code = codes.get(codeHash);
      if (code === undefined) return false;
      if (code.used) {
        revoke(code.family);
        return false;
      }
      code.used = true;
      if (
        code.registration !== registration ||
        code.redirectUri !== redirectUri ||
        code.challenge !== challenge ||
        code.until <= clock()
      )
        return false;
      if (resource !== null && code.resource !== null && resource !== code.resource) return false;
      if (revokedClients.has(code.client)) return false;
      issue({ client: code.client, family: code.family, registration }, accessHash, refreshHash);
      return true;
    },
    refresh: async ({ registration, refreshHash, accessHash, nextRefreshHash }) => {
      const old = tokens.get(refreshHash);
      if (old === undefined || old.kind !== "refresh") return false;
      if (old.used || old.revoked || old.registration !== registration) {
        revoke(old.family);
        return false;
      }
      if (old.until <= clock() || revokedClients.has(old.client)) return false;
      old.used = true;
      issue({ client: old.client, family: old.family, registration }, accessHash, nextRefreshHash);
      return true;
    },
  };
  const approve = (code: string, client = "cli_a") =>
    approvals.set(sha(code.replaceAll("-", "")), { client, until: clock() + 10 * MINUTE, used: false });
  // The client an access token reaches, as current_client() decides.
  const clientOf = (token: string): string | null => {
    const found = tokens.get(sha(token));
    return found !== undefined &&
      found.kind === "access" &&
      !found.revoked &&
      found.until > clock() &&
      !revokedClients.has(found.client)
      ? found.client
      : null;
  };
  return { store, approve, clientOf, revokedClients, registrations };
}

const HOLDER = clientView({ tools: ["get_self"], views: ["self"] });

function setup() {
  let at = 1_000_000;
  const clock = () => at;
  const fake = fakeStore(clock);
  const { provider } = fakeProvider(HOLDER, {
    client: async (token) => (token === TOKEN || fake.clientOf(token) !== null ? HOLDER : null),
  });
  const { log, events } = fakeLog();
  const routes = createRoutes({ provider, work: NO_WORK }, log, {
    ...AT_ONCE,
    now: clock,
    oauth: { base: BASE, store: fake.store },
  });
  const send = (request: Partial<HttpRequest> & { path: string }) =>
    routes({ method: "GET", address: "203.0.113.1", body: "", host: HOST, ...request });
  const advance = (ms: number) => {
    at += ms;
  };
  return { fake, send, advance, events };
}
type Flow = ReturnType<typeof setup>;
const body = (answer: { body: string }) => JSON.parse(answer.body) as Record<string, unknown>;
const form = (values: Record<string, string>) => new URLSearchParams(values).toString();

async function register(flow: Flow, uris: string[] = [CHATGPT], address = "203.0.113.1"): Promise<string> {
  const answer = await flow.send({
    method: "POST",
    path: "/oauth/register",
    address,
    body: JSON.stringify({ redirect_uris: uris, client_name: "ChatGPT", token_endpoint_auth_method: "none" }),
  });
  expect(answer.status).toBe(201);
  return body(answer).client_id as string;
}
const authorizeQuery = (client: string, over: Record<string, string | undefined> = {}) => {
  const values: Record<string, string | undefined> = {
    client_id: client,
    redirect_uri: CHATGPT,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "s-1",
    resource: RESOURCE,
    scope: "pi offline_access",
    ...over,
  };
  return new URLSearchParams(
    Object.entries(values).filter((pair): pair is [string, string] => pair[1] !== undefined),
  ).toString();
};
// The consent page's request handle.
const handleOf = (page: string): string => /name="request" value="([^"]+)"/.exec(page)?.[1] ?? "";
async function consentPage(flow: Flow, client: string, over: Record<string, string | undefined> = {}) {
  return flow.send({ path: "/oauth/authorize", query: authorizeQuery(client, over) });
}
async function approveWith(flow: Flow, request: string, code: string) {
  return flow.send({ method: "POST", path: "/oauth/authorize", origin: BASE, body: form({ request, code }) });
}
// Register, approve, and the authorization code from the redirect.
async function codeFor(flow: Flow, uri = CHATGPT): Promise<{ client: string; code: string; location: URL }> {
  const client = await register(flow, [uri]);
  flow.fake.approve(APPROVAL);
  const page = await consentPage(flow, client, { redirect_uri: uri });
  const answer = await approveWith(flow, handleOf(page.body), APPROVAL.toLowerCase());
  expect(answer.status).toBe(302);
  const location = new URL(answer.headers?.location ?? "");
  return { client, code: location.searchParams.get("code") ?? "", location };
}
const exchange = (flow: Flow, values: Record<string, string>) =>
  flow.send({
    method: "POST",
    path: "/oauth/token",
    body: form({
      grant_type: "authorization_code",
      redirect_uri: CHATGPT,
      code_verifier: VERIFIER,
      resource: RESOURCE,
      ...values,
    }),
  });
const refreshWith = (flow: Flow, client: string, token: string) =>
  flow.send({
    method: "POST",
    path: "/oauth/token",
    body: form({ grant_type: "refresh_token", client_id: client, refresh_token: token }),
  });
const listTools = (flow: Flow, token?: string) =>
  flow.send({
    method: "POST",
    path: "/mcp",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });

describe("OAuth discovery", () => {
  it("serves the protected resource and authorization server metadata with no token, and no OpenID Connect discovery", async () => {
    const { send } = setup();
    const resource = {
      resource: RESOURCE,
      authorization_servers: [BASE],
      scopes_supported: ["pi"],
      bearer_methods_supported: ["header"],
    };
    expect(body(await send({ path: "/.well-known/oauth-protected-resource" }))).toEqual(resource);
    expect(body(await send({ path: "/.well-known/oauth-protected-resource/mcp" }))).toEqual(resource);
    const server = body(await send({ path: "/.well-known/oauth-authorization-server" }));
    expect((await send({ path: "/.well-known/openid-configuration" })).status).toBe(404);
    expect(server).toEqual({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["pi", "offline_access"],
      authorization_response_iss_parameter_supported: true,
    });
    expect(server).not.toHaveProperty("client_id_metadata_document_supported");
  });

  it("without a base URL, no OAuth route exists and a bad token is still 403", async () => {
    const { provider } = fakeProvider(HOLDER, { client: async () => null });
    const routes = createRoutes({ provider, work: NO_WORK }, fakeLog().log, AT_ONCE);
    expect(
      (await routes({ method: "GET", path: "/.well-known/oauth-protected-resource", address: "a", body: "" })).status,
    ).toBe(404);
    expect((await routes({ method: "POST", path: "/oauth/token", address: "a", body: "" })).status).toBe(404);
    expect((await routes({ method: "GET", path: "/v1/tools", address: "a", body: "" })).status).toBe(403);
  });
});

describe("the uniform 401", () => {
  it("no token, an unknown one, an expired one and a revoked client's answer the same 401", async () => {
    const flow = setup();
    const { client, code } = await codeFor(flow);
    const issued = body(await exchange(flow, { client_id: client, code }));
    const access = issued.access_token as string;
    expect((await listTools(flow, access)).status).toBe(200);
    const expected = {
      status: 401,
      body: '{"error":"unauthorized"}',
      type: "application/json",
      headers: { "www-authenticate": `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"` },
    };
    const answers = [
      await listTools(flow),
      await listTools(flow, "pio_unknown"),
      await flow.send({ path: "/v1/tools" }),
      await flow.send({ method: "POST", path: "/v1/tools/get_self", authorization: "Bearer x", body: "{}" }),
    ];
    flow.advance(60 * MINUTE);
    answers.push(await listTools(flow, access));
    for (const answer of answers) expect(answer).toEqual(expected);
  });

  it("a refresh token is no access token", async () => {
    const flow = setup();
    const { client, code } = await codeFor(flow);
    const issued = body(await exchange(flow, { client_id: client, code }));
    expect((await listTools(flow, issued.refresh_token as string)).status).toBe(401);
  });

  it("the 429 of 20 failed checks a minute stays", async () => {
    const flow = setup();
    for (let n = 0; n < 20; n += 1) expect((await listTools(flow, "bad")).status).toBe(401);
    expect((await listTools(flow, TOKEN)).status).toBe(429);
  });
});

describe("registration", () => {
  it("takes Claude's callback, ChatGPT's two, and loopback on any port", async () => {
    const flow = setup();
    for (const uris of [
      [CLAUDE],
      [CHATGPT],
      ["https://chatgpt.com/connector/oauth/abc_DEF-123"],
      ["http://localhost:3118/callback", "http://127.0.0.1:50000/callback"],
      ["http://localhost/callback"],
    ]) {
      await register(flow, uris);
    }
  });

  it("refuses any other redirect URI, and bad metadata", async () => {
    const flow = setup();
    // Each from its own address, though a refused body counts against no limit.
    let n = 0;
    const refused = async (metadata: unknown) =>
      (
        await flow.send({
          method: "POST",
          path: "/oauth/register",
          address: `198.51.100.${(n += 1)}`,
          body: JSON.stringify(metadata),
        })
      ).body;
    for (const uri of [
      "http://evil.example/callback",
      "http://localhost:3118/other",
      "http://localhost:99999/callback",
      "https://claude.ai/api/mcp/auth_callback?x=1",
      "https://chatgpt.com.evil.example/connector_platform_oauth_redirect",
      "https://evil.example/api/mcp/auth_callback",
      "http://claude.ai/api/mcp/auth_callback",
    ]) {
      expect(await refused({ redirect_uris: [uri] }), uri).toBe('{"error":"invalid_redirect_uri"}');
    }
    expect(await refused({ redirect_uris: [] })).toBe('{"error":"invalid_redirect_uri"}');
    expect(await refused({ redirect_uris: Array.from({ length: 6 }, () => CLAUDE) })).toBe(
      '{"error":"invalid_redirect_uri"}',
    );
    expect(await refused({ redirect_uris: [CLAUDE], client_name: "x".repeat(101) })).toBe(
      '{"error":"invalid_client_metadata"}',
    );
    expect(await refused({ redirect_uris: [CLAUDE], token_endpoint_auth_method: "client_secret_basic" })).toBe(
      '{"error":"invalid_client_metadata"}',
    );
    expect(await refused({ redirect_uris: [CLAUDE], grant_types: ["client_credentials"] })).toBe(
      '{"error":"invalid_client_metadata"}',
    );
    expect((await flow.send({ method: "POST", path: "/oauth/register", body: "{" })).status).toBe(400);
    expect(flow.fake.registrations.size).toBe(0);
  });

  it("answers per RFC 7591, grants nothing, and limits each address", async () => {
    const flow = setup();
    const answer = await flow.send({
      method: "POST",
      path: "/oauth/register",
      body: JSON.stringify({ redirect_uris: [CLAUDE], client_name: "Claude" }),
    });
    expect(answer.status).toBe(201);
    const value = body(answer);
    expect(value).toMatchObject({
      redirect_uris: [CLAUDE],
      client_name: "Claude",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(value.client_id).toMatch(/^oc_[A-Za-z0-9_-]{32}$/);
    expect((await listTools(flow, value.client_id as string)).status).toBe(401);
    for (let n = 1; n < MAX_REGISTRATIONS; n += 1) await register(flow, [CLAUDE]);
    expect(
      (await flow.send({ method: "POST", path: "/oauth/register", body: JSON.stringify({ redirect_uris: [CLAUDE] }) }))
        .status,
    ).toBe(429);
    await register(flow, [CLAUDE], "203.0.113.9");
    flow.advance(60 * MINUTE);
    await register(flow, [CLAUDE]);
  });

  it("every address together registers at most the total an hour", async () => {
    const flow = setup();
    for (let n = 0; n < MAX_REGISTRATIONS_TOTAL; n += 1) await register(flow, [CLAUDE], `10.0.${n >> 8}.${n & 255}`);
    const next = () =>
      flow.send({
        method: "POST",
        path: "/oauth/register",
        address: "192.0.2.77",
        body: JSON.stringify({ redirect_uris: [CLAUDE] }),
      });
    expect((await next()).status).toBe(429);
    expect(flow.events.some((event) => event.code === "registration_throttled_total")).toBe(true);
    flow.advance(60 * MINUTE);
    expect((await next()).status).toBe(201);
  });

  it("only a registration that is stored counts against the limits", async () => {
    const flow = setup();
    const bad = () =>
      flow.send({ method: "POST", path: "/oauth/register", body: JSON.stringify({ redirect_uris: ["http://x/y"] }) });
    for (let n = 0; n < MAX_REGISTRATIONS + 5; n += 1) expect((await bad()).status).toBe(400);
    expect((await flow.send({ method: "POST", path: "/oauth/register", body: "{" })).status).toBe(400);
    for (let n = 0; n < MAX_REGISTRATIONS; n += 1) await register(flow, [CLAUDE]);
    expect((await bad()).status).toBe(429);
  });

  it("an IPv6 address registers as its /64", async () => {
    const flow = setup();
    for (let n = 1; n <= MAX_REGISTRATIONS; n += 1) await register(flow, [CLAUDE], `2001:db8:5:6::${n.toString(16)}`);
    const from = (address: string) =>
      flow.send({
        method: "POST",
        path: "/oauth/register",
        address,
        body: JSON.stringify({ redirect_uris: [CLAUDE] }),
      });
    expect((await from("2001:db8:5:6:aaaa:bbbb:cccc:dddd")).status).toBe(429);
    expect((await from("2001:db8:5:7::1")).status).toBe(201);
  });

  it("one IPv6 /48 registers at most its share of the total", async () => {
    const flow = setup();
    const from = (address: string) =>
      flow.send({
        method: "POST",
        path: "/oauth/register",
        address,
        body: JSON.stringify({ redirect_uris: [CLAUDE] }),
      });
    let made = 0;
    for (let net = 1; made < MAX_REGISTRATIONS_PER_BLOCK; net += 1)
      for (let n = 0; n < MAX_REGISTRATIONS && made < MAX_REGISTRATIONS_PER_BLOCK; n += 1, made += 1)
        expect((await from(`2001:db8:5:${net.toString(16)}::${(n + 1).toString(16)}`)).status).toBe(201);
    expect((await from("2001:db8:5:ff::1")).status).toBe(429);
    expect(flow.events.some((event) => event.code === "registration_throttled_block")).toBe(true);
    // Another /48, and an IPv4 address, are not held up.
    expect((await from("2001:db8:6:1::1")).status).toBe(201);
    expect((await from("192.0.2.5")).status).toBe(201);
  });

  it("a registration the store fails spends nothing", async () => {
    const flow = setup();
    const stored = flow.fake.store.register;
    flow.fake.store.register = async () => {
      throw new Error("down");
    };
    for (let n = 0; n < MAX_REGISTRATIONS; n += 1)
      await expect(
        flow.send({ method: "POST", path: "/oauth/register", body: JSON.stringify({ redirect_uris: [CLAUDE] }) }),
      ).rejects.toThrow("down");
    flow.fake.store.register = stored;
    for (let n = 0; n < MAX_REGISTRATIONS; n += 1) await register(flow, [CLAUDE]);
  });

  it("blockKey: an IPv6 /64 is in its /48; anything else is its own block", () => {
    expect(blockKey("2001:db8:5:6::/64")).toBe("2001:db8:5::/48");
    expect(blockKey("203.0.113.1")).toBe("203.0.113.1");
    expect(blockKey("unknown")).toBe("unknown");
  });

  it("past the store's cap a registration still succeeds", async () => {
    const flow = setup();
    for (let n = 0; n < 100; n += 1) await register(flow, [CLAUDE], `198.51.100.${n}`);
    // The next hour, under the total.
    flow.advance(60 * MINUTE);
    expect(
      (
        await flow.send({
          method: "POST",
          path: "/oauth/register",
          address: "192.0.2.1",
          body: JSON.stringify({ redirect_uris: [CLAUDE] }),
        })
      ).status,
    ).toBe(201);
    expect(flow.fake.registrations.size).toBe(100);
  });
});

describe("redirect matching", () => {
  it("exact for https, the port ignored for loopback", () => {
    expect(redirectMatches(CHATGPT, [CHATGPT])).toBe(true);
    expect(redirectMatches(CLAUDE, [CHATGPT])).toBe(false);
    expect(redirectMatches("http://localhost:4000/callback", ["http://localhost:3118/callback"])).toBe(true);
    expect(redirectMatches("http://127.0.0.1:4000/callback", ["http://127.0.0.1/callback"])).toBe(true);
    expect(redirectMatches("http://127.0.0.1:4000/callback", ["http://localhost:3118/callback"])).toBe(false);
    expect(redirectMatches("http://localhost:4000/other", ["http://localhost:3118/callback"])).toBe(false);
    expect(allowedRedirect("http://localhost:0/callback")).toBe(false);
  });
});

describe("authorization", () => {
  it("validates the request: unknown client or redirect shows a page and redirects nowhere", async () => {
    const flow = setup();
    const client = await register(flow);
    for (const answer of [
      await consentPage(flow, "oc_unknown"),
      await consentPage(flow, client, { redirect_uri: CLAUDE }),
      await consentPage(flow, client, { redirect_uri: undefined }),
      await flow.send({ path: "/oauth/authorize", query: `${authorizeQuery(client)}&client_id=${client}` }),
    ]) {
      expect(answer.status).toBe(400);
      expect(answer.headers?.location).toBeUndefined();
    }
  });

  it("other faults redirect with the error, the state and iss", async () => {
    const flow = setup();
    const client = await register(flow);
    const cases: [Record<string, string | undefined>, string][] = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: undefined }, "invalid_request"],
      [{ state: undefined }, "invalid_request"],
      [{ resource: `${BASE}/other` }, "invalid_target"],
    ];
    for (const [over, error] of cases) {
      const answer = await consentPage(flow, client, over);
      expect(answer.status, error).toBe(302);
      const location = new URL(answer.headers?.location ?? "");
      expect(`${location.origin}${location.pathname}`).toBe(CHATGPT);
      expect(location.searchParams.get("error")).toBe(error);
      expect(location.searchParams.get("iss")).toBe(BASE);
      if (over.state === undefined && "state" in over) expect(location.searchParams.has("state")).toBe(false);
      else expect(location.searchParams.get("state")).toBe("s-1");
    }
  });

  it("the consent page is escaped, scriptless, shows the redirect host and the registration's fingerprint, and warns for loopback only", async () => {
    const flow = setup();
    const client = await register(flow);
    flow.fake.registrations.set(client, { redirectUris: [CHATGPT], clientName: '<script>alert("x")</script>' });
    const page = await consentPage(flow, client);
    expect(page.status).toBe(200);
    expect(page.type).toBe("text/html");
    expect(page.body).not.toContain("<script");
    expect(page.body).toContain("&lt;script&gt;");
    expect(page.body).toContain("<strong>chatgpt.com</strong>");
    expect(page.body).toContain("<code>pia oauth approve NAME --registration FINGERPRINT</code>");
    expect(page.body).toContain(`<strong><code>FP${client.slice(3, 5)}-PRNT</code></strong>`);
    expect(page.body).not.toContain("Warning");
    expect(page.headers?.["content-security-policy"]).toBe(
      "default-src 'none'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
    );
    const local = await register(flow, ["http://localhost:3118/callback", "http://127.0.0.1:3118/callback"]);
    const loopback = await consentPage(flow, local, { redirect_uri: "http://localhost:5555/callback" });
    expect(loopback.status).toBe(200);
    expect(loopback.body).toContain("<strong>localhost</strong>");
    expect(loopback.body).toContain("Warning");
    expect(loopback.headers?.["content-security-policy"]).toContain("form-action 'self' http://localhost:5555;");
  });

  it("a foreign Host gets no page, and a POST from another origin is refused", async () => {
    const flow = setup();
    const client = await register(flow);
    expect(
      (await flow.send({ path: "/oauth/authorize", query: authorizeQuery(client), host: "evil.example" })).status,
    ).toBe(421);
    flow.fake.approve(APPROVAL);
    const request = handleOf((await consentPage(flow, client)).body);
    for (const origin of [undefined, "null", "https://evil.example"]) {
      const answer = await flow.send({
        method: "POST",
        path: "/oauth/authorize",
        ...(origin === undefined ? {} : { origin }),
        body: form({ request, code: APPROVAL }),
      });
      expect(answer.status, String(origin)).toBe(403);
    }
    expect((await approveWith(flow, "x".repeat(43), APPROVAL)).status).toBe(400);
    expect((await approveWith(flow, request, APPROVAL)).status).toBe(302);
  });

  it("five wrong codes end the request; the right code then does nothing", async () => {
    const flow = setup();
    const client = await register(flow);
    flow.fake.approve(APPROVAL);
    const request = handleOf((await consentPage(flow, client)).body);
    for (let n = 1; n < MAX_WRONG_CODES; n += 1) {
      const wrong = await approveWith(flow, request, n % 2 === 0 ? "nonsense" : "ZZZZ-ZZZZ-ZZZZ");
      expect(wrong.status).toBe(400);
      expect(wrong.body).toContain("not accepted");
      expect(handleOf(wrong.body)).toBe(request);
    }
    expect((await approveWith(flow, request, "ZZZZ-ZZZZ-ZZZZ")).body).toContain("Too many codes");
    expect((await approveWith(flow, request, APPROVAL)).status).toBe(400);
    // The approval code itself is unspent: a new request takes it.
    const again = handleOf((await consentPage(flow, client)).body);
    expect((await approveWith(flow, again, APPROVAL)).status).toBe(302);
  });

  // A request that spent its codes keeps its pending slot until it expires, so one address can try
  // at most its pending cap times the budget in ten minutes, however fast it starts requests.
  it("a request that spent its codes keeps its slot until it expires", async () => {
    const flow = setup();
    const client = await register(flow);
    const address = "198.51.100.9";
    const ask = () => flow.send({ path: "/oauth/authorize", query: authorizeQuery(client), address });
    for (let n = 0; n < MAX_PENDING_PER_ADDRESS; n += 1) {
      const request = handleOf((await ask()).body);
      for (let tried = 0; tried < MAX_WRONG_CODES; tried += 1)
        expect((await approveWith(flow, request, "ZZZZ-ZZZZ-ZZZZ")).status).toBe(400);
      expect((await approveWith(flow, request, "ZZZZ-ZZZZ-ZZZZ")).body).toContain("Too many codes");
    }
    expect((await ask()).status).toBe(429);
    flow.advance(10 * MINUTE);
    expect((await ask()).status).toBe(200);
  });

  it("an approval code is single use, expires, and a request expires too", async () => {
    const flow = setup();
    const client = await register(flow);
    flow.fake.approve(APPROVAL);
    expect((await approveWith(flow, handleOf((await consentPage(flow, client)).body), APPROVAL)).status).toBe(302);
    expect((await approveWith(flow, handleOf((await consentPage(flow, client)).body), APPROVAL)).status).toBe(400);
    flow.fake.approve("QQQQ-QQQQ-QQQQ");
    const late = handleOf((await consentPage(flow, client)).body);
    flow.advance(10 * MINUTE);
    expect((await approveWith(flow, late, "QQQQ-QQQQ-QQQQ")).body).toContain("has ended");
  });

  it("codes are tried against each request's own budget: a stranger's wrong codes never spend the owner's", async () => {
    const flow = setup();
    const client = await register(flow);
    // A stranger, from many addresses, spends every code its own requests may try.
    for (let n = 0; n < 2 * MAX_PENDING_PER_ADDRESS; n += 1) {
      const request = handleOf(
        (await flow.send({ path: "/oauth/authorize", query: authorizeQuery(client), address: `198.51.100.${n}` })).body,
      );
      for (let tried = 0; tried < MAX_WRONG_CODES; tried += 1)
        expect((await approveWith(flow, request, "ZZZZ-ZZZZ-ZZZZ")).status).toBe(400);
    }
    // The owner's request, started now, takes the owner's code at once.
    flow.fake.approve(APPROVAL);
    const request = handleOf((await consentPage(flow, client)).body);
    expect((await approveWith(flow, request, APPROVAL)).status).toBe(302);
  });

  it("pending requests are capped per address, and over every address", async () => {
    const flow = setup();
    const client = await register(flow);
    const ask = (address: string) => flow.send({ path: "/oauth/authorize", query: authorizeQuery(client), address });
    for (let n = 0; n < MAX_PENDING_PER_ADDRESS; n += 1) expect((await ask("198.51.100.1")).status).toBe(200);
    const refused = await ask("198.51.100.1");
    expect(refused.status).toBe(429);
    expect(handleOf(refused.body)).toBe("");
    expect((await ask("203.0.113.1")).status).toBe(200);
    // The global cap stays: past it every address waits.
    let made = MAX_PENDING_PER_ADDRESS + 1;
    for (let n = 0; made < MAX_PENDING; n += 1)
      for (let k = 0; k < MAX_PENDING_PER_ADDRESS && made < MAX_PENDING; k += 1, made += 1)
        expect((await ask(`10.1.0.${n}`)).status).toBe(200);
    expect((await ask("192.0.2.200")).status).toBe(503);
    // Requests end after ten minutes, and their slots with them.
    flow.advance(10 * MINUTE);
    expect((await ask("198.51.100.1")).status).toBe(200);
  });

  it("pending requests are capped per IPv6 /48", async () => {
    const flow = setup();
    const client = await register(flow);
    const ask = (address: string) => flow.send({ path: "/oauth/authorize", query: authorizeQuery(client), address });
    let made = 0;
    for (let net = 1; made < MAX_PENDING_PER_BLOCK; net += 1)
      for (let n = 0; n < MAX_PENDING_PER_ADDRESS && made < MAX_PENDING_PER_BLOCK; n += 1, made += 1)
        expect((await ask(`2001:db8:7:${net.toString(16)}::1`)).status).toBe(200);
    const refused = await ask("2001:db8:7:ff::1");
    expect(refused.status).toBe(429);
    expect(handleOf(refused.body)).toBe("");
    expect((await ask("2001:db8:8:1::1")).status).toBe(200);
  });

  it("the right code redirects with code, state and iss", async () => {
    const flow = setup();
    const { location, code } = await codeFor(flow);
    expect(`${location.origin}${location.pathname}`).toBe(CHATGPT);
    expect(location.searchParams.get("state")).toBe("s-1");
    expect(location.searchParams.get("iss")).toBe(BASE);
    expect(code).toMatch(/^poc_[A-Za-z0-9_-]{43}$/);
  });
});

describe("the token endpoint", () => {
  it("exchanges a code once, form-encoded, answering per RFC 6749", async () => {
    const flow = setup();
    const { client, code } = await codeFor(flow);
    const answer = await exchange(flow, { client_id: client, code });
    expect(answer.status).toBe(200);
    expect(answer.headers).toEqual({ pragma: "no-cache" });
    const issued = body(answer);
    expect(issued).toEqual({
      access_token: expect.stringMatching(/^pio_/),
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^pir_/),
      scope: "pi",
    });
    expect(body(await listTools(flow, issued.access_token as string)).result).toBeDefined();
    // Reused: refused, and what it issued is revoked.
    expect(body(await exchange(flow, { client_id: client, code }))).toEqual({ error: "invalid_grant" });
    expect((await listTools(flow, issued.access_token as string)).status).toBe(401);
  });

  it("a wrong verifier, redirect URI, client or resource is invalid_grant, and spends the code", async () => {
    for (const [over, error] of [
      [{ code_verifier: "w".repeat(43) }, "invalid_grant"],
      [{ redirect_uri: CLAUDE }, "invalid_grant"],
      [{ client_id: "oc_other" }, "invalid_grant"],
      [{ resource: `${BASE}/other` }, "invalid_target"],
      [{ code_verifier: "short" }, "invalid_request"],
    ] as const) {
      const flow = setup();
      const { client, code } = await codeFor(flow);
      expect(body(await exchange(flow, { client_id: client, code, ...over })), JSON.stringify(over)).toEqual({ error });
      if (error === "invalid_grant")
        expect(body(await exchange(flow, { client_id: client, code }))).toEqual({ error: "invalid_grant" });
    }
  });

  it("an expired code is invalid_grant", async () => {
    const flow = setup();
    const { client, code } = await codeFor(flow);
    flow.advance(5 * MINUTE);
    expect(body(await exchange(flow, { client_id: client, code }))).toEqual({ error: "invalid_grant" });
  });

  it("refresh rotates, and reuse of an old refresh token revokes the family", async () => {
    const flow = setup();
    const { client, code } = await codeFor(flow);
    const first = body(await exchange(flow, { client_id: client, code }));
    const second = body(await refreshWith(flow, client, first.refresh_token as string));
    expect(second).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await listTools(flow, second.access_token as string)).status).toBe(200);
    // The old one again: refused, and the new pair goes with it.
    expect(body(await refreshWith(flow, client, first.refresh_token as string))).toEqual({ error: "invalid_grant" });
    expect((await listTools(flow, second.access_token as string)).status).toBe(401);
    expect(body(await refreshWith(flow, client, second.refresh_token as string))).toEqual({
      error: "invalid_grant",
    });
  });

  it("other grants, missing parameters and repeats are refused", async () => {
    const flow = setup();
    const token = (values: string) => flow.send({ method: "POST", path: "/oauth/token", body: values });
    expect(body(await token("grant_type=client_credentials&client_id=oc_x"))).toEqual({
      error: "unsupported_grant_type",
    });
    expect(body(await token("grant_type=refresh_token"))).toEqual({ error: "invalid_request" });
    expect(body(await token("grant_type=refresh_token&client_id=a&client_id=b&refresh_token=x"))).toEqual({
      error: "invalid_request",
    });
    expect(body(await refreshWith(flow, "oc_x", "pir_unknown"))).toEqual({ error: "invalid_grant" });
    expect((await flow.send({ path: "/oauth/token" })).status).toBe(405);
  });
});

describe("OAuth, the log and the hold", () => {
  it("logs event codes only: no token, code, verifier, name or redirect URI", async () => {
    const flow = setup();
    const { client, code } = await codeFor(flow);
    const issued = body(await exchange(flow, { client_id: client, code }));
    await refreshWith(flow, client, issued.refresh_token as string);
    const logged = JSON.stringify(flow.events);
    for (const secret of [
      code,
      issued.access_token,
      issued.refresh_token,
      VERIFIER,
      CHALLENGE,
      client,
      "ChatGPT",
      "chatgpt.com",
      APPROVAL,
      "s-1",
    ])
      expect(logged).not.toContain(String(secret));
    for (const event of flow.events)
      expect(Object.keys(event).every((key) => ["event", "code", "status", "ids", "durationMs"].includes(key))).toBe(
        true,
      );
  });

  it("the read hold stops OAuth too", async () => {
    const { provider } = fakeProvider(HOLDER);
    const routes = createRoutes({ provider, work: NO_WORK }, fakeLog().log, {
      ...AT_ONCE,
      held: () => true,
      oauth: { base: BASE, store: fakeStore(() => 0).store },
    });
    expect(
      (await routes({ method: "GET", path: "/.well-known/oauth-authorization-server", address: "a", body: "" })).status,
    ).toBe(503);
  });
});

describe("OAuth through the server", () => {
  it("passes the query, sends the 401's challenge and a page's headers", async () => {
    const fake = fakeStore(() => Date.now());
    const { provider } = fakeProvider(HOLDER, { client: async () => null });
    const server = serveHttp({ provider, work: NO_WORK }, fakeLog().log, {
      ...AT_ONCE,
      oauth: { base: BASE, store: fake.store },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const denied = await fetch(`${url}/mcp`, {
        method: "POST",
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
      });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
      );
      expect(denied.headers.get("cache-control")).toBe("no-store");
      expect(
        ((await (await fetch(`${url}/.well-known/oauth-protected-resource?x=1`)).json()) as { resource: string })
          .resource,
      ).toBe(RESOURCE);
      const registered = await fetch(`${url}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [CLAUDE] }),
      });
      expect(registered.status).toBe(201);
      // The consent page is for the box's own name: here the Host is the loopback's.
      const page = await fetch(`${url}/oauth/authorize?${authorizeQuery("oc_x")}`);
      expect([page.status, page.headers.get("content-type")]).toEqual([421, "text/html; charset=utf-8"]);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    } finally {
      server.close();
    }
  });
});
