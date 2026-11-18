import { createHash, randomBytes } from "node:crypto";
import type { PersonalLogger, PersonalOAuth } from "@intelligence/contracts/personal";
import { approvalCodeText, OAUTH_ACCESS_SECONDS } from "@intelligence/contracts/personal";
import { MAX_ADDRESSES, type Window, windowAt } from "./windows.ts";

// OAuth 2.1 for the agent endpoint, for an
// MCP client that speaks only OAuth: ChatGPT's custom MCP servers and Claude's custom connectors.
// Discovery, dynamic registration, the owner's consent by a code from the terminal, and the token
// endpoint. Every token and code is random, handed to the store only as its SHA-256, and never
// logged; the log carries event codes only. The tokens it issues are checked where every client
// token is, by policy.current_client(), so an OAuth client is an ordinary client.

export type OAuthOptions = {
  // The public https origin, PI_HTTP_BASE_URL. The resource is `<base>/mcp`.
  base: string;
  store: PersonalOAuth;
  // The wall clock of the limits and of the pending authorization requests.
  now?: () => number;
};

export type OAuthRequest = {
  method: string;
  path: string;
  query: string;
  address: string;
  body: string;
  host?: string | undefined;
  origin?: string | undefined;
};
export type OAuthAnswer = {
  status: number;
  body: string;
  type: "application/json" | "text/html";
  headers?: Record<string, string>;
};

const MINUTE = 60_000;
// An authorization request lives ten minutes, and at most this many are pending at
// once, over every address, from any one IPv6 /48 (blockKey) and from any one address.
const PENDING_MS = 10 * MINUTE;
export const MAX_PENDING = 200;
export const MAX_PENDING_PER_BLOCK = 20;
export const MAX_PENDING_PER_ADDRESS = 10;
// The codes one authorization request may try. The budget is the request's own, so a
// stranger's wrong codes spend only that stranger's requests, never the owner's. A request that
// spent it is ended but keeps its pending slot until it expires, so a new request cannot take its
// place sooner: the pending caps bound the tries, at most MAX_PENDING_PER_ADDRESS times this from
// one address, MAX_PENDING_PER_BLOCK times this from one IPv6 /48 and MAX_PENDING times this over
// every address, in ten minutes.
export const MAX_WRONG_CODES = 5;
// Registrations one address may make in an hour, one IPv6 /48, and every address
// together.
export const MAX_REGISTRATIONS = 10;
export const MAX_REGISTRATIONS_PER_BLOCK = 20;
export const MAX_REGISTRATIONS_TOTAL = 100;
const REGISTRATION_WINDOW_MS = 60 * MINUTE;

// The block an address key (http.ts, addressKey) belongs to, for the caps between one address's
// and every address's: an IPv6 /64 is in its /48, the block one site is usually given, so one
// site cannot fill a global cap alone. Any other key, IPv4 included, is its own block.
export function blockKey(address: string): string {
  const v6 = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(address);
  return v6 === null ? address : `${v6[1]}:${v6[2]}:${v6[3]}::/48`;
}

// The window's count, or a new one when the hour is up.
const inWindow = (seen: Window | undefined, at: number): Window => windowAt(seen, at, REGISTRATION_WINDOW_MS);

// The redirect URIs a registration may hold. Claude's hosted apps; ChatGPT's two; and
// Claude Code's loopback (RFC 8252), the only URIs that are not https, matched with any port.
const REDIRECTS = [
  /^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/,
  /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/,
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/,
];
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(?::(\d{1,5}))?\/callback$/;

const isLoopback = (uri: string): boolean => {
  const port = LOOPBACK.exec(uri)?.[2];
  return LOOPBACK.test(uri) && (port === undefined || (Number(port) >= 1 && Number(port) <= 65_535));
};
export const allowedRedirect = (uri: string): boolean =>
  REDIRECTS.some((pattern) => pattern.test(uri)) || isLoopback(uri);
// A loopback URI without its port; any other URI as it is.
const portless = (uri: string): string => (isLoopback(uri) ? uri.replace(LOOPBACK, "http://$1/callback") : uri);
// The requested URI is one registered, exactly, or a loopback one on another port.
export const redirectMatches = (requested: string, registered: string[]): boolean =>
  allowedRedirect(requested) &&
  registered.some(
    (one) => one === requested || (isLoopback(one) && isLoopback(requested) && portless(one) === portless(requested)),
  );

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const random = (prefix: string): string => `${prefix}${randomBytes(32).toString("base64url")}`;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE = /^[\x21-\x7e]{1,512}$/;
const REQUEST = /^[A-Za-z0-9_-]{43}$/;

const json = (status: number, value: unknown, headers?: Record<string, string>): OAuthAnswer => ({
  status,
  body: JSON.stringify(value),
  type: "application/json",
  ...(headers === undefined ? {} : { headers }),
});

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (one) => ENTITIES[one] ?? one);

// One value of each name, or null when a name the request needs is repeated.
function single(params: URLSearchParams, names: readonly string[]): Record<string, string | undefined> | null {
  const values: Record<string, string | undefined> = {};
  for (const name of names) {
    const all = params.getAll(name);
    if (all.length > 1) return null;
    values[name] = all[0];
  }
  return values;
}

type Pending = {
  // The address that asked for it, for the per-address cap.
  address: string;
  registration: string;
  redirectUri: string;
  challenge: string;
  state: string;
  resource: string | null;
  wrong: number;
  until: number;
};

// What every step of the endpoint reads: its base, the resource it serves, the store and the clock,
// the requests waiting for the owner's approval, and how a refusal is logged.
type OAuthContext = {
  base: string;
  resource: string;
  store: PersonalOAuth;
  now: () => number;
  log: PersonalLogger;
  pending: Map<string, Pending>;
  refuse: (answer: OAuthAnswer, code: string) => OAuthAnswer;
  notice: (status: number, code: string, text: string) => OAuthAnswer;
};
// The registrations counted in the hour, by address, by block and in all.
type Registrations = { addresses: Map<string, Window>; blocks: Map<string, Window>; all: Window };

// The protected resource's and the authorization server's metadata.
function metadataOf(base: string, resource: string) {
  const protectedResource = {
    resource,
    authorization_servers: [base],
    scopes_supported: ["pi"],
    bearer_methods_supported: ["header"],
  };
  const authorizationServer = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["pi", "offline_access"],
    authorization_response_iss_parameter_supported: true,
  };
  return { protectedResource, authorizationServer };
}

// Pages carry no script and no style; a form posts here, and its answer may
// redirect only to the request's own redirect URI.
const page = (status: number, title: string, inner: string, redirect?: string): OAuthAnswer => ({
  status,
  type: "text/html",
  body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${inner}</body></html>`,
  headers: {
    "content-security-policy": `default-src 'none'; form-action 'self'${redirect === undefined ? "" : ` ${new URL(redirect).origin}`}; frame-ancestors 'none'; base-uri 'none'`,
    "referrer-policy": "same-origin",
  },
});

// The consent page. The registration's fingerprint, which the owner names to `pia
// oauth approve` or `pia oauth code`, so the code given opens this registration and no other.
const consent = (
  id: string,
  request: Pending,
  registration: { clientName: string | null; fingerprint: string; onlyLoopback: boolean },
  wrong: boolean,
): OAuthAnswer => {
  const target = new URL(request.redirectUri).hostname;
  const name = registration.clientName;
  const lines = [
    `<p>An application asks to use Personal Intelligence as one of your clients. It will be sent to <strong>${escapeHtml(target)}</strong>.</p>`,
    name === null ? "" : `<p>It calls itself: ${escapeHtml(name)}</p>`,
    `<p>Its fingerprint: <strong><code>${escapeHtml(registration.fingerprint)}</code></strong></p>`,
    registration.onlyLoopback
      ? "<p><strong>Warning:</strong> it returns only to a program on this computer, and any program on it can claim that address. Go on only if you started this from a program you trust.</p>"
      : "",
    "<p>Approve only a request you started. In the box's terminal run <code>pia oauth approve NAME --registration FINGERPRINT</code> (or <code>pia oauth code NAME --registration FINGERPRINT</code> for a client already registered) with the fingerprint above, check that the command printed the same one, and enter the approval code it printed. A code made for another fingerprint is not accepted here.</p>",
    wrong ? "<p><strong>That code was not accepted.</strong></p>" : "",
    `<form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${escapeHtml(id)}"><label>Approval code <input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label> <button type="submit">Approve</button></form>`,
  ];
  return page(wrong ? 400 : 200, "Approve a client", lines.join(""), request.redirectUri);
};

// RFC 6749 4.1.2.1 and RFC 9207: the error to the client's redirect URI, with its state and iss.
function redirect(base: string, uri: string, values: Record<string, string>): OAuthAnswer {
  const to = new URL(uri);
  for (const [name, value] of Object.entries({ ...values, iss: base })) to.searchParams.set(name, value);
  return { status: 302, body: "", type: "text/html", headers: { location: to.toString() } };
}

// A registration's metadata, or the refusal of it: its redirect URIs, each one this
// endpoint allows, and the client's name.
function registrationOf(body: string): { uris: string[]; clientName: string | null } | { error: string; code: string } {
  let metadata: unknown;
  try {
    metadata = JSON.parse(body);
  } catch {
    return { error: "invalid_client_metadata", code: "registration_parse" };
  }
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
    return { error: "invalid_client_metadata", code: "registration_parse" };
  const {
    redirect_uris: uris,
    client_name: name,
    token_endpoint_auth_method: method,
    grant_types: grants,
    response_types: responses,
  } = metadata as Record<string, unknown>;
  if (
    !Array.isArray(uris) ||
    uris.length < 1 ||
    uris.length > 5 ||
    !uris.every((uri) => typeof uri === "string" && allowedRedirect(uri))
  ) {
    return { error: "invalid_redirect_uri", code: "registration_redirect" };
  }
  const listOf = (value: unknown, allowed: string[]): boolean =>
    value === undefined ||
    (Array.isArray(value) && value.every((one) => typeof one === "string" && allowed.includes(one)));
  if (
    (name !== undefined && name !== null && (typeof name !== "string" || name.length > 100)) ||
    (method !== undefined && method !== "none") ||
    !listOf(grants, ["authorization_code", "refresh_token"]) ||
    !listOf(responses, ["code"])
  ) {
    return { error: "invalid_client_metadata", code: "registration_metadata" };
  }
  return { uris: uris as string[], clientName: typeof name === "string" && name !== "" ? name : null };
}

// The limits are asked before the body is read, and only a registration that is
// stored counts against them, so a body that is refused, or one the store fails, spends nothing.
async function register(
  { store, now, log, refuse }: OAuthContext,
  windows: Registrations,
  { body, address }: OAuthRequest,
): Promise<OAuthAnswer> {
  const at = now();
  const block = blockKey(address);
  const mine = inWindow(windows.addresses.get(address), at);
  const theirs = inWindow(windows.blocks.get(block), at);
  windows.all = inWindow(windows.all, at);
  const all = windows.all;
  if (mine.count >= MAX_REGISTRATIONS) return refuse(json(429, { error: "rate_limited" }), "registration_throttled");
  if (theirs.count >= MAX_REGISTRATIONS_PER_BLOCK)
    return refuse(json(429, { error: "rate_limited" }), "registration_throttled_block");
  if (all.count >= MAX_REGISTRATIONS_TOTAL)
    return refuse(json(429, { error: "rate_limited" }), "registration_throttled_total");

  const metadata = registrationOf(body);
  if ("error" in metadata) return refuse(json(400, { error: metadata.error }), metadata.code);
  const { uris, clientName } = metadata;
  const id = `oc_${randomBytes(24).toString("base64url")}`;
  // Held before the store is asked, with nothing awaited since the limits were checked, so two
  // registrations at once cannot both pass the last place; given back when the store fails, so
  // only a stored registration counts.
  const hold = (by: number): void => {
    mine.count += by;
    theirs.count += by;
    all.count += by;
  };
  if (windows.addresses.size >= MAX_ADDRESSES) windows.addresses.clear();
  if (windows.blocks.size >= MAX_ADDRESSES) windows.blocks.clear();
  windows.addresses.set(address, mine);
  windows.blocks.set(block, theirs);
  hold(1);
  try {
    await store.register(id, { redirectUris: uris, clientName });
  } catch (error) {
    hold(-1);
    throw error;
  }
  log.info({ event: "oauth_registered" });
  return json(201, {
    client_id: id,
    client_id_issued_at: Math.floor(at / 1000),
    redirect_uris: uris,
    ...(clientName === null ? {} : { client_name: clientName }),
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

async function authorizeGet(
  { base, resource, store, now, pending, refuse, notice }: OAuthContext,
  { query, address }: OAuthRequest,
): Promise<OAuthAnswer> {
  const params = single(new URLSearchParams(query), [
    "client_id",
    "redirect_uri",
    "response_type",
    "code_challenge",
    "code_challenge_method",
    "state",
    "resource",
  ]);
  // Until the client and its redirect URI are known, nothing is sent anywhere (RFC 6749 4.1.2.1).
  if (params === null || params.client_id === undefined || params.redirect_uri === undefined)
    return notice(400, "authorize_request", "This request is not valid.");
  const registration = await store.registration(params.client_id);
  const uri = params.redirect_uri;
  if (registration === null || !redirectMatches(uri, registration.redirectUris))
    return notice(400, "authorize_client", "This request is not valid.");
  const state = params.state;
  const fail = (error: string, code: string): OAuthAnswer =>
    refuse(redirect(base, uri, { error, ...(state === undefined ? {} : { state }) }), code);
  if (params.response_type !== "code") return fail("unsupported_response_type", "authorize_response_type");
  if (state === undefined || !STATE.test(state)) return fail("invalid_request", "authorize_state");
  if (params.code_challenge_method !== "S256" || !CHALLENGE.test(params.code_challenge ?? ""))
    return fail("invalid_request", "authorize_pkce");
  const asked = params.resource;
  if (asked !== undefined && asked !== resource) return fail("invalid_target", "authorize_resource");

  const at = now();
  for (const [id, one] of pending) if (one.until <= at) pending.delete(id);
  if (pending.size >= MAX_PENDING)
    return notice(503, "authorize_busy", "Too many requests are waiting. Try again in a few minutes.");
  const block = blockKey(address);
  let mine = 0;
  let theirs = 0;
  for (const one of pending.values()) {
    if (one.address === address) mine += 1;
    if (blockKey(one.address) === block) theirs += 1;
  }
  if (mine >= MAX_PENDING_PER_ADDRESS)
    return notice(429, "authorize_busy_address", "Too many requests are waiting. Try again in a few minutes.");
  if (theirs >= MAX_PENDING_PER_BLOCK)
    return notice(429, "authorize_busy_block", "Too many requests are waiting. Try again in a few minutes.");
  const id = randomBytes(32).toString("base64url");
  const request: Pending = {
    address,
    registration: params.client_id,
    redirectUri: uri,
    challenge: params.code_challenge ?? "",
    state,
    resource: asked ?? null,
    wrong: 0,
    until: at + PENDING_MS,
  };
  pending.set(id, request);
  return consent(
    id,
    request,
    {
      clientName: registration.clientName,
      fingerprint: registration.fingerprint,
      onlyLoopback: registration.redirectUris.every(isLoopback),
    },
    false,
  );
}

async function authorizePost(
  { base, store, now, log, pending, notice }: OAuthContext,
  { body, origin }: OAuthRequest,
): Promise<OAuthAnswer> {
  // The page's own origin, and the request handle the page holds, before anything
  // is read.
  if (origin !== base) return notice(403, "authorize_origin", "This request is not valid.");
  const at = now();
  const form = single(new URLSearchParams(body), ["request", "code"]);
  const id = form?.request ?? "";
  const request = REQUEST.test(id) ? pending.get(id) : undefined;
  if (form === null || request === undefined || request.until <= at)
    return notice(400, "authorize_expired", "This request has ended. Start again from the application.");
  const spent = (): OAuthAnswer =>
    notice(400, "authorize_wrong_codes", "Too many codes were not accepted. Start again from the application.");
  if (request.wrong >= MAX_WRONG_CODES) return spent();

  const typed = approvalCodeText(form.code ?? "");
  const code = random("poc_");
  const approved =
    typed !== null &&
    (await store.authorize({
      registration: request.registration,
      approvalHash: sha256(typed),
      codeHash: sha256(code),
      redirectUri: request.redirectUri,
      challenge: request.challenge,
      resource: request.resource,
    }));
  if (!approved) {
    request.wrong += 1;
    // Ended, but its slot is kept until it expires.
    if (request.wrong >= MAX_WRONG_CODES) return spent();
    const registration = await store.registration(request.registration);
    log.warn({ event: "oauth_refused", code: "authorize_wrong_code", status: "http_400" });
    return consent(
      id,
      request,
      {
        clientName: registration?.clientName ?? null,
        fingerprint: registration?.fingerprint ?? "",
        onlyLoopback: registration?.redirectUris.every(isLoopback) ?? false,
      },
      true,
    );
  }
  pending.delete(id);
  log.info({ event: "oauth_approved" });
  return redirect(base, request.redirectUri, { code, state: request.state });
}

// RFC 6749 5.1 and 5.2.
async function token({ resource, store, log, refuse }: OAuthContext, { body }: OAuthRequest): Promise<OAuthAnswer> {
  const noStore = { pragma: "no-cache" };
  const error = (code: string, detail: string): OAuthAnswer => refuse(json(400, { error: code }, noStore), detail);
  const params = single(new URLSearchParams(body), [
    "grant_type",
    "client_id",
    "code",
    "code_verifier",
    "redirect_uri",
    "refresh_token",
    "resource",
  ]);
  if (params === null || params.client_id === undefined) return error("invalid_request", "token_request");
  const asked = params.resource ?? null;
  if (asked !== null && asked !== resource) return error("invalid_target", "token_resource");
  const access = random("pio_");
  const refresh = random("pir_");
  const issued = (): OAuthAnswer => {
    log.info({ event: "oauth_issued" });
    return json(
      200,
      {
        access_token: access,
        token_type: "Bearer",
        expires_in: OAUTH_ACCESS_SECONDS,
        refresh_token: refresh,
        scope: "pi",
      },
      noStore,
    );
  };
  if (params.grant_type === "authorization_code") {
    const { code, code_verifier: verifier, redirect_uri: uri } = params;
    if (code === undefined || uri === undefined || verifier === undefined || !VERIFIER.test(verifier))
      return error("invalid_request", "token_request");
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const ok = await store.exchange({
      registration: params.client_id,
      codeHash: sha256(code),
      challenge,
      redirectUri: uri,
      resource: asked,
      accessHash: sha256(access),
      refreshHash: sha256(refresh),
    });
    return ok ? issued() : error("invalid_grant", "token_code");
  }
  if (params.grant_type === "refresh_token") {
    const old = params.refresh_token;
    if (old === undefined) return error("invalid_request", "token_request");
    const ok = await store.refresh({
      registration: params.client_id,
      refreshHash: sha256(old),
      accessHash: sha256(access),
      nextRefreshHash: sha256(refresh),
    });
    return ok ? issued() : error("invalid_grant", "token_refresh");
  }
  return error("unsupported_grant_type", "token_grant_type");
}

export function createOAuth(options: OAuthOptions, log: PersonalLogger) {
  const { base, store, now = Date.now } = options;
  const resource = `${base}/mcp`;
  const host = new URL(base).host;
  const metadataUrl = `${base}/.well-known/oauth-protected-resource`;
  // What every failed token check on /mcp and /v1/* carries.
  const challenge = `Bearer resource_metadata="${metadataUrl}"`;
  const { protectedResource, authorizationServer } = metadataOf(base, resource);

  const refuse = (answer: OAuthAnswer, code: string): OAuthAnswer => {
    log.warn({ event: "oauth_refused", code, status: `http_${answer.status}` });
    return answer;
  };
  const notice = (status: number, code: string, text: string): OAuthAnswer =>
    refuse(page(status, "Personal Intelligence", `<p>${escapeHtml(text)}</p>`), code);
  const ctx: OAuthContext = { base, resource, store, now, log, pending: new Map(), refuse, notice };
  const windows: Registrations = { addresses: new Map(), blocks: new Map(), all: { count: 0, since: 0 } };

  const ROUTES: Record<string, Record<string, (request: OAuthRequest) => Promise<OAuthAnswer>>> = {
    "/.well-known/oauth-protected-resource": { GET: async () => json(200, protectedResource) },
    "/.well-known/oauth-protected-resource/mcp": { GET: async () => json(200, protectedResource) },
    "/.well-known/oauth-authorization-server": { GET: async () => json(200, authorizationServer) },
    // No `/.well-known/openid-configuration`: this is an OAuth server, not an OpenID provider, and
    // an MCP client reads the authorization server metadata above (RFC 8414) when it is served.
    "/oauth/register": { POST: (request) => register(ctx, windows, request) },
    "/oauth/authorize": {
      GET: (request) => authorizeGet(ctx, request),
      POST: (request) => authorizePost(ctx, request),
    },
    "/oauth/token": { POST: (request) => token(ctx, request) },
  };

  return {
    challenge,
    handles: (path: string): boolean => Object.hasOwn(ROUTES, path),
    async route(request: OAuthRequest): Promise<OAuthAnswer> {
      const methods = ROUTES[request.path] ?? {};
      const handler = Object.hasOwn(methods, request.method) ? methods[request.method] : undefined;
      if (handler === undefined) return refuse(json(405, { error: "method_not_allowed" }), "method_not_allowed");
      // A page is served for this box's own name only.
      if (request.path === "/oauth/authorize" && request.host !== host)
        return notice(421, "authorize_host", "This request is not valid.");
      return handler(request);
    },
  };
}
