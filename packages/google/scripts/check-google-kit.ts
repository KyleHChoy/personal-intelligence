// What every mode of the live Google check shares: the env and port checks, the terminal, the
// result and step lines, the loopback consent, the token file, requests through the port and
// sent directly, the messages.get pace, and the connector listing and account helpers.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { HttpPort } from "@intelligence/contracts";
import {
  buildAuthUrl,
  type createGoogleConnector,
  GOOGLE_SCOPES,
  GoogleError,
  type GrantKind,
  listenForCode,
  pkcePair,
  scopesFor,
  type TokenSource,
} from "@intelligence/personal-google";

export type Result = "yes" | "no" | "not_observed";
// At most one count, or a few named counts.
export type Outcome = Result | [Result, number] | [Result, Record<string, number>];
type Connector = ReturnType<typeof createGoogleConnector>;
type Credential = Parameters<typeof createGoogleConnector>[1];
export type Account = Parameters<Connector["listChanges"]>[0];
export type Cursor = NonNullable<Parameters<Connector["listChanges"]>[1]>;
export type Page = Awaited<ReturnType<Connector["listChanges"]>>;
export type Params = [string, string][];
export type Kept = { refreshToken: string; issuedAt: number; historyId: string | null };

export const TOKEN_DIR = join(homedir(), ".config", "pi-check");
export const TOKEN_FILE = join(TOKEN_DIR, "token.json");
export const DAY_MS = 86_400_000;
export const MAX_PAGES = 10;
// The deadline of each request this script sends itself.
export const TIMEOUT_MS = 30_000;
const PACE_MS = 250;
// How long the quota check fetches at that pace, and how long the lag check waits.
export const PACE_RUN_MS = 60_000;

export const line = (fields: Record<string, unknown>): void => void process.stderr.write(`${JSON.stringify(fields)}\n`);
export const say = (text: string): void => void process.stderr.write(`${text}\n`);
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const strings = (value: unknown): string[] =>
  listOf(value).filter((one): one is string => typeof one === "string");
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const clientId = process.env.PI_CHECK_CLIENT_ID ?? "";
export const clientSecret = process.env.PI_CHECK_CLIENT_SECRET ?? "";
if (clientId === "" || clientSecret === "") {
  line({ event: "missing_env" });
  process.exit(1);
}
const portText = process.env.PI_CHECK_PORT;
const port = portText === undefined ? undefined : Number(portText);
if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
  line({ event: "bad_port" });
  process.exit(1);
}

export const terminal = createInterface({ input: process.stdin, output: process.stderr });

// One result line. A check that throws is reported by its error code only, then not_observed.
export async function check(name: string, run: () => Promise<Outcome> | Outcome): Promise<void> {
  let outcome: Outcome;
  try {
    outcome = await run();
  } catch (error) {
    line({ event: "check_error", check: name, code: error instanceof GoogleError ? error.code : "error" });
    outcome = "not_observed";
  }
  const [result, count] = typeof outcome === "string" ? [outcome] : outcome;
  line({
    event: "check_result",
    check: name,
    result,
    ...(count === undefined ? {} : typeof count === "number" ? { count } : { counts: count }),
  });
}

// A step that is no check of its own but that later checks read. A failure is reported by its
// code, and the checks that need it report not_observed.
export async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    line({ event: "step_failed", step: name, code: error instanceof GoogleError ? error.code : "error" });
    return null;
  }
}

// The loopback flow: a consent in the owner's browser, and the code it returns.
export async function consent(
  grant: GrantKind = "mail",
  loginHint?: string,
): Promise<{ code: string; redirectUri: string; verifier: string }> {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(32).toString("base64url");
  const { redirectUri, code } = await listenForCode(state, port);
  say("Open this URL in a browser signed in to the throwaway account, within five minutes:");
  say(
    buildAuthUrl({
      grant,
      clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
      ...(loginHint === undefined ? {} : { loginHint }),
    }),
  );
  return { code: await code, redirectUri, verifier };
}

export function keepToken(refreshToken: string, historyId: string | null, file: string = TOKEN_FILE): void {
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  chmodSync(TOKEN_DIR, 0o700);
  writeFileSync(file, JSON.stringify({ refreshToken, issuedAt: new Date().toISOString(), historyId }), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function keptToken(file: string = TOKEN_FILE): Kept | null {
  if (!existsSync(file)) return null;
  const kept: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(kept) || typeof kept.refreshToken !== "string" || typeof kept.issuedAt !== "string")
    throw new Error("the token file is not this script's");
  const historyId = typeof kept.historyId === "string" ? kept.historyId : null;
  return { refreshToken: kept.refreshToken, issuedAt: Date.parse(kept.issuedAt), historyId };
}

// A GET through the package's port, as the connector sends one: its parsed body, or a
// GoogleError by the port's answer table.
export async function portGet(http: HttpPort, url: string): Promise<unknown> {
  return (await http.send({ method: "GET", url, headers: {}, timeoutMs: TIMEOUT_MS, kind: "read" })).body;
}

// A request the package is built never to send, made directly with an access token.
export async function direct(tokens: TokenSource, url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${await tokens.accessToken()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: null };
  }
}

let lastFetch = 0;
export async function paced(): Promise<void> {
  const wait = lastFetch + PACE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetch = Date.now();
}

export const refused = (status: number, ...expected: number[]): Result =>
  expected.includes(status) ? "yes" : status === 200 ? "no" : "not_observed";

// A listing through the connector, to its end or the page cap.
export async function listAll(
  connector: Connector,
  account: Account,
  limit: number,
): Promise<{ pages: Page[]; ended: boolean; next: Cursor }> {
  const pages: Page[] = [];
  let cursor: Cursor | null = null;
  for (;;) {
    const page: Page = await connector.listChanges(account, cursor, limit);
    pages.push(page);
    cursor = page.next;
    const ended = page.listing?.ended !== undefined;
    if (ended || pages.length === MAX_PAGES) return { pages, ended, next: page.next };
  }
}

export function account(
  connector: "google_mail" | "google_calendar" | "google_docs",
  id: string,
): { account: Account; credential: Credential } {
  const sourceAccount = id as Account["id"];
  const sourceKind = connector === "google_mail" ? "email" : connector === "google_calendar" ? "calendar" : "document";
  return {
    account: {
      id: sourceAccount,
      connector,
      sourceKind,
      vault: "personal",
      externalRef: "check",
      accessSyncKind: "none",
      compartments: ["own"],
      markerCompartments: [],
    },
    // The connector never reads the secret; the port's token source holds the real values.
    credential: {
      connector,
      sourceAccount,
      scopes: [...(connector === "google_docs" ? scopesFor("drive") : GOOGLE_SCOPES)],
      secret: "unused",
    },
  };
}
