import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { HttpRequest, SourceCredential } from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { repoRoot } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import { createGoogleConnector } from "./connector.ts";
import { createGoogleHttp, GOOGLE_SCOPES, type GoogleDeps, GoogleError, grantedScopesFor, scopesFor } from "./http.ts";
import * as entry from "./send.ts";
import { createSendHttp, sendMessage } from "./send.ts";

// The port for the send call and the one send. Every value is made up; the send endpoint is a fake
// fetch.

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const BYTES = new TextEncoder().encode("From: owner@quinn.test\r\n\r\naGk=\r\n");
type Call = { url: string; init: RequestInit };
type Answer = { status: number; body?: string } | Error | "hang";

function fake(answers: Answer[]) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (input, init = {}) => {
    calls.push({ url: String(input), init });
    const answer = answers[calls.length - 1];
    if (answer === undefined) return Promise.reject(new Error("the fake has no answer left"));
    if (answer === "hang")
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(new Response(answer.body ?? null, { status: answer.status }));
  };
  const deps: GoogleDeps = { fetch, sleep: async () => {}, now: () => 0, random: () => 0.5, timeoutMs: 50 };
  return { calls, deps, http: createSendHttp({ accessToken: "fake-access-token", deps }) };
}
const json = (body: unknown): Answer => ({ status: 200, body: JSON.stringify(body) });

describe("the send entry", () => {
  it("exports the write side alone", () => {
    expect(Object.keys(entry).sort()).toEqual(["createSendHttp", "renderMessage", "revokeSendToken", "sendMessage"]);
  });

  it("any URL but the send URL is off_allowlist, and so is a GET to the send URL", async () => {
    const asked: HttpRequest[] = [
      { method: "GET", url: SEND_URL, headers: {}, timeoutMs: 50, kind: "read" },
      { method: "GET", url: SEND_URL, headers: {}, timeoutMs: 50, kind: "write" },
      { method: "POST", url: SEND_URL, headers: {}, body: "{}", timeoutMs: 50, kind: "read" },
      ...[
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
        "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send",
        `${SEND_URL}?uploadType=media`,
        `${SEND_URL}/`,
        "http://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        "https://gmail.googleapis.com.example.test/gmail/v1/users/me/messages/send",
        "https://oauth2.googleapis.com/revoke",
        "https://oauth2.googleapis.com/token",
      ].map((url): HttpRequest => ({ method: "POST", url, headers: {}, body: "{}", timeoutMs: 50, kind: "write" })),
    ];
    for (const req of asked) {
      const { calls, http } = fake([json({ id: "fake-id" })]);
      const error = await http.send(req).catch((thrown: unknown) => thrown);
      expect(error, `${req.method} ${req.url} ${req.kind}`).toBeInstanceOf(GoogleError);
      expect((error as GoogleError).code).toBe("off_allowlist");
      expect(calls).toEqual([]);
    }
    // The positive control: a write POST to the send URL goes out, with the one token.
    const { calls, http } = fake([json({ id: "fake-id" })]);
    await http.send({ method: "POST", url: SEND_URL, headers: {}, body: "{}", timeoutMs: 50, kind: "write" });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer fake-access-token");
  });

  it("a send is one request, with the raw bytes in base64url and the thread id when given", async () => {
    for (const threadId of ["fake-thread", undefined]) {
      const { calls, http } = fake([json({ id: "fake-id", threadId: "fake-thread" })]);
      await sendMessage(http, BYTES, threadId);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(SEND_URL);
      expect(calls[0]?.init.method).toBe("POST");
      expect(calls[0]?.init.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer fake-access-token",
      });
      const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
      expect(body).toEqual({
        raw: Buffer.from(BYTES).toString("base64url"),
        ...(threadId === undefined ? {} : { threadId }),
      });
      expect(String(body.raw)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("a 200 with an id is sent, with the thread id or null", async () => {
    const cases: [Answer, unknown][] = [
      [
        json({ id: "fake-id", threadId: "fake-thread", labelIds: ["SENT"] }),
        { outcome: "sent", id: "fake-id", threadId: "fake-thread" },
      ],
      [json({ id: "fake-id" }), { outcome: "sent", id: "fake-id", threadId: null }],
      [json({ id: "fake-id", threadId: "" }), { outcome: "sent", id: "fake-id", threadId: null }],
      [json({ id: "fake-id", threadId: 7 }), { outcome: "sent", id: "fake-id", threadId: null }],
      [
        { status: 201, body: JSON.stringify({ id: "fake-id" }) },
        { outcome: "sent", id: "fake-id", threadId: null },
      ],
    ];
    for (const [answer, result] of cases) expect(await sendMessage(fake([answer]).http, BYTES)).toEqual(result);
  });

  it("a 400, a 401, a 403, a 404 and a 429 are failed, with the status", async () => {
    for (const status of [400, 401, 403, 404, 409, 413, 429]) {
      expect(await sendMessage(fake([{ status, body: '{"error":{"code":1}}' }]).http, BYTES), String(status)).toEqual({
        outcome: "failed",
        status,
      });
    }
    // A 403 that is a rate limit is still a refusal Gmail gave.
    const limited = { status: 403, body: JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }) };
    expect(await sendMessage(fake([limited]).http, BYTES)).toEqual({ outcome: "failed", status: 403 });
  });

  it("a 200 with no id, a 200 whose id is empty, a 200 whose body is not JSON, a 302, a 408, a 500, a timeout and an error while connecting are each unknown", async () => {
    const answers: Answer[] = [
      json({}),
      json({ id: "" }),
      json({ id: 7 }),
      json(["fake-id"]),
      json(null),
      { status: 200, body: "not json" },
      { status: 200 },
      { status: 302 },
      { status: 304 },
      { status: 408 },
      { status: 500 },
      { status: 503 },
      "hang",
      new Error("connect ECONNREFUSED"),
      new TypeError("fetch failed"),
    ];
    for (const answer of answers)
      expect(
        await sendMessage(fake([answer]).http, BYTES),
        String(answer instanceof Error ? answer.message : JSON.stringify(answer)),
      ).toEqual({ outcome: "unknown" });
    // So is an answer over the port's bound, and anything the port throws.
    const throwing = { send: () => Promise.reject(new Error("anything")) };
    expect(await sendMessage(throwing, BYTES)).toEqual({ outcome: "unknown" });
    const unstatused = { send: () => Promise.reject(new GoogleError("unavailable")) };
    expect(await sendMessage(unstatused, BYTES)).toEqual({ outcome: "unknown" });
  });

  it("sendMessage throws for none of them, and each answer is one request: none is retried, the 401 included", async () => {
    const answers: Answer[] = [
      json({ id: "fake-id" }),
      { status: 401 },
      { status: 429 },
      { status: 500 },
      { status: 503 },
      "hang",
      new Error("socket hang up"),
      { status: 302 },
    ];
    for (const answer of answers) {
      const { calls, http } = fake([answer, json({ id: "second" }), json({ id: "third" })]);
      await expect(sendMessage(http, BYTES)).resolves.toBeDefined();
      expect(calls, String(answer instanceof Error ? answer.message : JSON.stringify(answer))).toHaveLength(1);
    }
  });

  it("only apps/pi/src/send/send.ts, and the owner's live check script, import the send entry", () => {
    // The whole repository, tests included.
    const root = repoRoot();
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          /\.(ts|tsx|js|mjs)$/.test(name) &&
          /from\s+["']@intelligence\/personal-google\/send["']|import\(\s*["']@intelligence\/personal-google\/send["']/.test(
            readFileSync(path, "utf8"),
          )
        )
          importers.push(relative(root, path));
      }
    };
    walk(root);
    // The one other importer is the owner's hand-run live check, which no process runs: it must
    // send through the same renderMessage and sendMessage the live check proves.
    const allowed = ["apps/pi/src/send/send.ts", "packages/google/scripts/live-send-check.ts"];
    expect(
      importers.every((path) => allowed.includes(path)),
      importers.join(", "),
    ).toBe(true);
  });

  it("the connectors still refuse a credential with a send scope", () => {
    const sourceAccount = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
    const http = createGoogleHttp({ tokens: null, deps: {} });
    for (const scopes of [
      [...scopesFor("send")],
      [...grantedScopesFor("send")],
      [...GOOGLE_SCOPES, "https://www.googleapis.com/auth/gmail.send"],
    ]) {
      for (const connector of ["google_mail", "google_calendar"] as const) {
        const credential: SourceCredential = { connector, sourceAccount, scopes, secret: '{"fake":"secret"}' };
        expect(() => createGoogleConnector(connector, credential, http), `${connector} ${scopes.join(" ")}`).toThrow(
          new GoogleError("scope_mismatch"),
        );
      }
    }
  });
});
