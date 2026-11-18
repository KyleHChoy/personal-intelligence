import { createHash } from "node:crypto";
import type { PersonalLogEvent, PersonalLogger } from "@intelligence/contracts/personal";
import type { HttpRequest } from "@intelligence/personal-mcp";
import { createRoutes } from "@intelligence/personal-mcp";
import { createReader, createWork, type Reader } from "@intelligence/personal-store";
import { createTestDatabase, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pi as runPi } from "../test-support/run-pi.ts";

// Register, the owner's `pi oauth approve`, the consent page and its code, the token, tools/list on
// /mcp, a refresh, and the owner's revocation.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const BASE = "https://pi.example";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "e2e-verifier-".padEnd(64, "x");
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

const pi = (argv: string[], env: Record<string, string>, tty: boolean) => runPi(argv, env, { tty });

let db: TestDatabase;
let reader: Reader;
const events: PersonalLogEvent[] = [];
const log: PersonalLogger = {
  info: (event) => events.push(event),
  warn: (event) => events.push(event),
  error: (event) => events.push(event),
};
beforeAll(async () => {
  db = await createTestDatabase();
  reader = createReader({ url: db.urls.reader, keys: db.keys, log });
});
afterAll(async () => {
  await reader?.close();
  await db?.drop();
});

describe("pi http, OAuth end to end", () => {
  it("register, approve, authorize, token, tools/list, refresh, revoke", async () => {
    const routes = createRoutes({ provider: reader, work: createWork({ reader, log }) }, log, {
      oauth: { base: BASE, store: reader.oauth },
    });
    const send = (request: Partial<HttpRequest> & { path: string }) =>
      routes({ method: "GET", address: "203.0.113.1", body: "", host: "pi.example", ...request });
    const list = (token?: string) =>
      send({
        method: "POST",
        path: "/mcp",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      });

    // The client's first request: 401, pointing at discovery.
    const first = await list();
    expect(first.status).toBe(401);
    expect(first.headers?.["www-authenticate"]).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
    );
    expect(JSON.parse((await send({ path: "/.well-known/oauth-protected-resource" })).body)).toMatchObject({
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE],
    });

    const registered = await send({
      method: "POST",
      path: "/oauth/register",
      body: JSON.stringify({ redirect_uris: [CLAUDE], client_name: "Claude", token_endpoint_auth_method: "none" }),
    });
    expect(registered.status).toBe(201);
    const client = (JSON.parse(registered.body) as { client_id: string }).client_id;

    const query = new URLSearchParams({
      client_id: client,
      redirect_uri: CLAUDE,
      response_type: "code",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "st",
      resource: `${BASE}/mcp`,
      scope: "pi offline_access",
    });
    const page = await send({ path: "/oauth/authorize", query: query.toString() });
    expect(page.status).toBe(200);
    expect(page.body).toContain("<strong>claude.ai</strong>");
    const fingerprint = /<strong><code>([0-9A-Z]{4}-[0-9A-Z]{4})<\/code><\/strong>/.exec(page.body)?.[1] ?? "";
    expect(fingerprint).not.toBe("");

    // The owner, in the box's terminal. Not into a pipe. With no --registration, the waiting
    // registrations are listed and nothing is registered.
    const env = { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile };
    const listing = await pi(["oauth", "approve", "claude-web", "--views", "self", "--tools", "get_self"], env, true);
    expect(listing.exit).toBe(1);
    expect(listing.stderr).toContain('"code":"registration_needed"');
    expect(JSON.parse(listing.stdout)).toEqual([
      expect.objectContaining({ fingerprint, clientName: "Claude", redirectHosts: ["claude.ai"] }),
    ]);
    expect((await pi(["clients", "list"], env, false)).stdout).not.toContain('"name":"claude-web"');
    const args = [
      "oauth",
      "approve",
      "claude-web",
      "--registration",
      fingerprint,
      "--views",
      "self",
      "--tools",
      "get_self",
      "--runtime",
      "cloud",
      "--retention",
      "unknown",
    ];
    expect((await pi(args, env, false)).exit).toBe(1);
    const approved = await pi(args, env, true);
    expect(approved.exit).toBe(0);
    const code = approved.stdout.trim();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    // Registered exactly as `clients add` registers it.
    const listed = await pi(["clients", "list"], env, false);
    expect(listed.stdout).toContain('"name":"claude-web"');

    const request = /name="request" value="([^"]+)"/.exec(page.body)?.[1] ?? "";
    const answer = await send({
      method: "POST",
      path: "/oauth/authorize",
      origin: BASE,
      body: new URLSearchParams({ request, code: code.toLowerCase() }).toString(),
    });
    expect(answer.status).toBe(302);
    const location = new URL(answer.headers?.location ?? "");
    expect([location.searchParams.get("state"), location.searchParams.get("iss")]).toEqual(["st", BASE]);

    const token = (values: Record<string, string>) =>
      send({
        method: "POST",
        path: "/oauth/token",
        body: new URLSearchParams({ client_id: client, ...values }).toString(),
      });
    const issued = JSON.parse(
      (
        await token({
          grant_type: "authorization_code",
          code: location.searchParams.get("code") ?? "",
          code_verifier: VERIFIER,
          redirect_uri: CLAUDE,
          resource: `${BASE}/mcp`,
        })
      ).body,
    ) as { access_token: string; refresh_token: string; expires_in: number };
    expect(issued.expires_in).toBe(3600);

    const tools = JSON.parse((await list(issued.access_token)).body) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((tool) => tool.name)).toEqual(["get_self"]);

    const refreshed = JSON.parse(
      (await token({ grant_type: "refresh_token", refresh_token: issued.refresh_token })).body,
    ) as { access_token: string; refresh_token: string };
    expect(refreshed.refresh_token).not.toBe(issued.refresh_token);
    expect((await list(refreshed.access_token)).status).toBe(200);
    expect(
      JSON.parse((await token({ grant_type: "refresh_token", refresh_token: issued.refresh_token })).body),
    ).toEqual({ error: "invalid_grant" });
    expect((await list(refreshed.access_token)).status).toBe(401);

    // A flow that failed: a new code for the same client, with no new name, leads to the same client.
    const named = ["--registration", fingerprint];
    expect((await pi(["oauth", "code", "claude-web", ...named], env, false)).exit).toBe(1);
    expect((await pi(["oauth", "code", "nobody", ...named], env, true)).stderr).toContain('"code":"not_found"');
    expect((await pi(["oauth", "code", "claude-web", "--registration", "ZZZZ-ZZZZ"], env, true)).stderr).toContain(
      '"code":"unknown_registration"',
    );
    const fresh = await pi(["oauth", "code", "claude-web", ...named], env, true);
    expect(fresh.exit).toBe(0);
    const pageAgain = await send({ path: "/oauth/authorize", query: query.toString() });
    const requestAgain = /name="request" value="([^"]+)"/.exec(pageAgain.body)?.[1] ?? "";
    const codeAgain =
      new URL(
        (
          await send({
            method: "POST",
            path: "/oauth/authorize",
            origin: BASE,
            body: new URLSearchParams({ request: requestAgain, code: fresh.stdout.trim() }).toString(),
          })
        ).headers?.location ?? "",
      ).searchParams.get("code") ?? "";
    const issuedAgain = JSON.parse(
      (
        await token({
          grant_type: "authorization_code",
          code: codeAgain,
          code_verifier: VERIFIER,
          redirect_uri: CLAUDE,
        })
      ).body,
    ) as { access_token: string };
    expect((await list(issuedAgain.access_token)).status).toBe(200);
    expect((await pi(["clients", "list"], env, false)).stdout.match(/"name":"claude-web"/g)).toHaveLength(1);

    // A second grant, then the owner revokes the client: its tokens stop at once.
    const again = await pi(
      ["oauth", "approve", "claude-code", ...named, "--views", "self", "--tools", "get_self"],
      env,
      true,
    );
    const page2 = await send({ path: "/oauth/authorize", query: query.toString() });
    const request2 = /name="request" value="([^"]+)"/.exec(page2.body)?.[1] ?? "";
    const code2 =
      new URL(
        (
          await send({
            method: "POST",
            path: "/oauth/authorize",
            origin: BASE,
            body: new URLSearchParams({ request: request2, code: again.stdout.trim() }).toString(),
          })
        ).headers?.location ?? "",
      ).searchParams.get("code") ?? "";
    const issued2 = JSON.parse(
      (await token({ grant_type: "authorization_code", code: code2, code_verifier: VERIFIER, redirect_uri: CLAUDE }))
        .body,
    ) as { access_token: string; refresh_token: string };
    expect((await list(issued2.access_token)).status).toBe(200);
    expect((await pi(["clients", "revoke", "claude-code"], env, false)).exit).toBe(0);
    expect((await list(issued2.access_token)).status).toBe(401);
    expect(
      JSON.parse((await token({ grant_type: "refresh_token", refresh_token: issued2.refresh_token })).body),
    ).toEqual({ error: "invalid_grant" });

    // Nothing secret reached the log.
    const logged = JSON.stringify(events);
    for (const secret of [
      code,
      issued.access_token,
      issued.refresh_token,
      refreshed.access_token,
      VERIFIER,
      client,
      "Claude",
      "claude.ai",
    ])
      expect(logged).not.toContain(secret);
  });
});
