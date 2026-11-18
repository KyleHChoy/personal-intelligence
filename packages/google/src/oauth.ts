import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  createGoogleHttp,
  type GoogleDeps,
  GoogleError,
  type GrantKind,
  grantedScopesFor,
  isRecord,
  scopesFor,
  type TokenSource,
  withDefaults,
} from "./http.ts";

// The OAuth loopback flow that gets one account's refresh token, and the token source that
// turns it into access tokens. Tokens live in memory only; nothing here stores or logs one.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const LISTEN_TIMEOUT_MS = 5 * 60_000;
const EXPIRY_MARGIN_MS = 60_000;
// It echoes nothing of the request.
const PAGE =
  '<!doctype html><meta charset="utf-8"><title>Finished</title><p>Finished. Close this window and return to the terminal.</p>';

// Base64url of SHA-256, no padding.
export const pkceChallenge = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

// 32 random bytes as base64url, and their S256 challenge.
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

// The consent for one grant's scopes. No consent asks for include_granted_scopes. The login hint
// offers the right account first; it is a convenience, not the check (`exchangeCode` is).
export function buildAuthUrl({
  grant,
  clientId,
  redirectUri,
  state,
  codeChallenge,
  loginHint,
}: {
  grant: GrantKind;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
}): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopesFor(grant).join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    ...(loginHint === undefined ? {} : { login_hint: loginHint }),
  }).toString();
  return url.toString();
}

// `code` settles on the first request that carries the matching state, or rejects at the timeout.
export function listenForCode(
  state: string,
  port?: number,
  { timeoutMs = LISTEN_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<{ redirectUri: string; code: Promise<string> }> {
  return new Promise((resolveListening, rejectListening) => {
    let resolveCode: (code: string) => void = () => {};
    let rejectCode: (error: GoogleError) => void = () => {};
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    // The caller may not be waiting yet when the listener gives up; its own await still rejects.
    code.catch(() => {});
    let timer: NodeJS.Timeout | undefined;

    const server = createServer((request, response) => {
      const target = request.url ?? "";
      const url = URL.canParse(target, "http://127.0.0.1") ? new URL(target, "http://127.0.0.1") : null;
      const query = url?.searchParams;
      const granted = query?.get("code") ?? "";
      const denied = query?.has("error") ?? false;
      if (
        request.method !== "GET" ||
        url?.pathname !== "/" ||
        query?.get("state") !== state ||
        (!denied && granted === "")
      ) {
        response.writeHead(400, { Connection: "close" }).end();
        return;
      }
      // Once the page is written, every open connection ends with the listening socket, so an
      // idle peer cannot keep the process alive.
      response
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
        .end(PAGE, () => server.closeAllConnections());
      clearTimeout(timer);
      server.close();
      if (denied) rejectCode(new GoogleError("oauth_failed"));
      else resolveCode(granted);
    });

    // A port that cannot be bound, before the listener is up; nothing of the error is kept.
    server.on("error", () => {
      rejectListening(new GoogleError("oauth_failed"));
      rejectCode(new GoogleError("oauth_failed"));
    });
    server.listen(port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address !== null ? address.port : port;
      timer = setTimeout(() => {
        server.close();
        server.closeAllConnections();
        rejectCode(new GoogleError("oauth_failed"));
      }, timeoutMs);
      resolveListening({ redirectUri: `http://127.0.0.1:${bound}/`, code });
    });
  });
}

// One form POST to the token endpoint, through a port with no tokens. A code exchange is a write,
// sent once: a code is spent by its first use. A refresh changes nothing at Google, so it is sent
// as a read and retried as one is. An answer of 400 or 401, invalid_grant included, is oauth_failed
// at once; any other failure keeps its code.
async function tokenRequest(
  fields: Record<string, string>,
  kind: "read" | "write",
  deps: GoogleDeps,
): Promise<Record<string, unknown>> {
  const http = createGoogleHttp({ tokens: null, deps });
  const response = await http
    .send({
      method: "POST",
      url: TOKEN_URL,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      timeoutMs: withDefaults(deps).timeoutMs,
      kind,
    })
    .catch((error: unknown) => {
      if (error instanceof GoogleError && (error.status === 400 || error.status === 401))
        throw new GoogleError("oauth_failed", error.status);
      throw error;
    });
  if (!isRecord(response.body)) throw new GoogleError("bad_response");
  return response.body;
}

// A mail refresh answer that carries no scope is accepted until the live check
// (scripts/check-google.ts) shows both `refresh_answer_carries_scope yes` and
// `refresh_scope_exact yes`. Then this becomes false and such an answer is scope_mismatch, as it
// already is for every other grant. One that carries a scope is checked exactly either way.
export const MAIL_REFRESH_ACCEPTS_NO_SCOPE = true;

// The comparison is of sets, so a scope named twice is the same grant.
function isExactGrant(grant: GrantKind, scope: unknown): boolean {
  const granted = new Set(typeof scope === "string" ? scope.split(" ") : []);
  const wanted = grantedScopesFor(grant);
  return granted.size === wanted.length && wanted.every((one) => granted.has(one));
}

// It came from Google's token endpoint in this request, over TLS, so no signature is checked;
// nothing in it is read but `email` and `email_verified`.
function consentingAddress(idToken: unknown): string | null {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  if (parts.length !== 3) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(payload) || payload.email_verified !== true || typeof payload.email !== "string") return null;
  return payload.email.toLowerCase();
}

// `send` and `contacts` prove which account gave them: each needs `expectedAddress`, and mail and
// drive refuse one, before the code is spent. Drive holds no openid scope: sync checks its account
// with driveAbout.
export async function exchangeCode(
  {
    grant,
    clientId,
    clientSecret,
    code,
    redirectUri,
    codeVerifier,
    expectedAddress,
  }: {
    grant: GrantKind;
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    expectedAddress?: string;
  },
  deps: GoogleDeps = {},
): Promise<{ refreshToken: string }> {
  if ((grant === "send" || grant === "contacts") !== (expectedAddress !== undefined) || expectedAddress === "")
    throw new GoogleError("bad_request");
  const answer = await tokenRequest(
    {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    },
    "write",
    deps,
  );
  if (!isExactGrant(grant, answer.scope)) throw new GoogleError("scope_mismatch");
  if (expectedAddress !== undefined && consentingAddress(answer.id_token) !== expectedAddress.toLowerCase())
    throw new GoogleError("wrong_account");
  const refreshToken = answer.refresh_token;
  if (typeof refreshToken !== "string" || refreshToken === "") throw new GoogleError("oauth_failed");
  return { refreshToken };
}

// Held in memory only.
export function tokenSource(
  {
    grant,
    clientId,
    clientSecret,
    refreshToken,
  }: { grant: GrantKind; clientId: string; clientSecret: string; refreshToken: string },
  deps: GoogleDeps = {},
): TokenSource {
  const { now } = withDefaults(deps);
  let held: { token: string; refreshAt: number } | null = null;
  // A refresh under way: every request that needs a token meanwhile waits on it, so concurrent
  // fetches send one refresh, not one each.
  let refreshing: Promise<string> | null = null;
  async function refresh(at: number): Promise<string> {
    const answer = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret },
      "read",
      deps,
    );
    const { access_token: token, expires_in: seconds } = answer;
    if (typeof token !== "string" || token === "" || typeof seconds !== "number" || !Number.isFinite(seconds))
      throw new GoogleError("bad_response");
    const unscoped = grant === "mail" && MAIL_REFRESH_ACCEPTS_NO_SCOPE && answer.scope === undefined;
    if (!unscoped && !isExactGrant(grant, answer.scope)) throw new GoogleError("scope_mismatch");
    held = { token, refreshAt: at + seconds * 1000 - EXPIRY_MARGIN_MS };
    return token;
  }
  return {
    async accessToken() {
      const at = now();
      if (held !== null && at < held.refreshAt) return held.token;
      refreshing ??= refresh(at).finally(() => {
        refreshing = null;
      });
      return refreshing;
    },
    invalidate() {
      held = null;
    },
  };
}
