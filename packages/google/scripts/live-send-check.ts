// The live send check. Only the owner runs it, by hand on their own computer, against a throwaway
// Google account, before `pi send connect` is run on any real account:
//
//   node packages/google/scripts/live-send-check.ts
//
// It is not part of the package and no test runs it. Every assumption the send path makes about what
// Gmail or Google's OAuth does is inferred; each has one line here, and a line that fails
// reopens the rule that rests on it.
//
// - It reads the read client from PI_CHECK_CLIENT_ID and PI_CHECK_CLIENT_SECRET, the send client
//   from PI_CHECK_SEND_CLIENT_ID and PI_CHECK_SEND_CLIENT_SECRET, and the loopback port
//   from PI_CHECK_PORT (default: a free port).
// - It makes the read consent and the send consent on the throwaway account, and sends only to
//   that account itself.
// - It keeps its tokens in one throwaway file, $HOME/.config/pi-check/send-check.json
//   (directory 0700, file 0600), and deletes it at the end, whatever happened.
// - It writes one JSON line per assumption, in a fixed order, to stderr:
//   the line's name and `ok` or `failed`, and `skipped` for a line the owner chose to skip.
//   Prompts go to stderr too. It prints no address and no text. Nothing goes to stdout.
// - A line that needs the owner's hand in a browser (a second account, the app's access at
//   Google's page) prompts for it and waits.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { messageBodyHash } from "@intelligence/contracts/body-hash";
import type { SendPayload } from "@intelligence/contracts/personal";
import {
  buildAuthUrl,
  createGoogleHttp,
  exchangeCode,
  GOOGLE_SCOPES,
  GoogleError,
  type GrantKind,
  gmailProfile,
  listenForCode,
  pkcePair,
  type TokenSource,
  tokenSource,
} from "@intelligence/personal-google";
import { createSendHttp, renderMessage, revokeSendToken, sendMessage } from "@intelligence/personal-google/send";

const LINES = [
  "send_scope_alone_accepted",
  "send_scope_set_exact",
  "send_refresh_scope_exact",
  "consent_by_other_account_refused",
  "send_with_thread_id_accepted",
  "reply_threads",
  "send_from_is_account",
  "send_from_other_address_is_rewritten",
  "sent_id_is_listed_id",
  "sent_copy_listed_under_sent",
  "sent_copy_arrives_by_history",
  "sent_copy_body_hash_matches",
  "sent_copy_recipients_match",
  "subject_round_trips",
  "send_4xx_leaves_nothing_under_sent",
  "read_grant_unchanged",
  "read_refresh_scope_unchanged_after_send_consent",
  "revoking_send_token_leaves_read",
  "removing_app_access_scope",
  "one_client_keeps_consents_apart",
] as const;
type Line = (typeof LINES)[number];
type Result = "ok" | "failed" | "skipped";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// The send grant's scopes in the forms a token answer names them (http.ts, GRANTED.send).
const SEND_GRANTED = [
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];
const TOKEN_DIR = join(homedir(), ".config", "pi-check");
const TOKEN_FILE = join(TOKEN_DIR, "send-check.json");
const TIMEOUT_MS = 30_000;
const ARRIVAL_MS = 120_000;
// The text of sent_copy_body_hash_matches: a line outside ASCII, a line of 1 200 characters, a
// line that starts `From `, trailing spaces and a quoted line.
const HARD_BODY = [
  "Grüße aus Zürich, 東京からも",
  "x".repeat(1200),
  "From the start of a line",
  "trailing spaces   ",
  "> a quoted line",
  "the end",
].join("\n");
const SUBJECT = "Prüfung ✓ 確認 der Sendung";

const say = (text: string): void => void process.stderr.write(`${text}\n`);
const results = new Map<Line, Result>();
const record = (name: Line, result: Result): void => void results.set(name, result);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");

const env = (name: string): string => process.env[name] ?? "";
const read = { clientId: env("PI_CHECK_CLIENT_ID"), clientSecret: env("PI_CHECK_CLIENT_SECRET") };
const send = { clientId: env("PI_CHECK_SEND_CLIENT_ID"), clientSecret: env("PI_CHECK_SEND_CLIENT_SECRET") };
if ([read.clientId, read.clientSecret, send.clientId, send.clientSecret].includes("")) {
  say(JSON.stringify({ event: "missing_env" }));
  process.exit(1);
}
const portText = process.env.PI_CHECK_PORT;
const port = portText === undefined ? undefined : Number(portText);
if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
  say(JSON.stringify({ event: "bad_port" }));
  process.exit(1);
}
const terminal = createInterface({ input: process.stdin, output: process.stderr });

// The tokens of this run, in the one throwaway file.
const kept: Record<string, string> = {};
function keep(name: string, token: string): void {
  kept[name] = token;
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  chmodSync(TOKEN_DIR, 0o700);
  writeFileSync(TOKEN_FILE, JSON.stringify(kept), { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
}

// One loopback consent in the owner's browser, exchanged by the package's exchangeCode.
async function consent(
  grant: GrantKind,
  client: { clientId: string; clientSecret: string },
  prompt: string,
  expectedAddress?: string,
): Promise<string> {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(32).toString("base64url");
  const { redirectUri, code } = await listenForCode(state, port);
  say(prompt);
  // No login hint: the URL is printed, and the script prints no address.
  say(buildAuthUrl({ grant, clientId: client.clientId, redirectUri, state, codeChallenge: challenge }));
  const { refreshToken } = await exchangeCode({
    grant,
    ...client,
    code: await code,
    redirectUri,
    codeVerifier: verifier,
    ...(expectedAddress === undefined ? {} : { expectedAddress }),
  });
  return refreshToken;
}

// A refresh made directly, so its `scope` can be read: the scopes it names, or null when it
// names none. Its access token is dropped.
async function refreshScopes(
  client: { clientId: string; clientSecret: string },
  refreshToken: string,
): Promise<{ status: number; scopes: string[] | null }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let scope: unknown;
  try {
    scope = (JSON.parse(text) as Record<string, unknown>).scope;
  } catch {
    scope = undefined;
  }
  return {
    status: response.status,
    scopes: typeof scope === "string" ? scope.split(" ").filter((one) => one !== "") : null,
  };
}

const readTokens = (refreshToken: string, client = read): TokenSource =>
  tokenSource({ grant: "mail", ...client, refreshToken });
const sendTokens = (refreshToken: string, client = send): TokenSource =>
  tokenSource({ grant: "send", ...client, refreshToken });

// A GET through the read port.
async function get(
  tokens: TokenSource,
  path: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${GMAIL}/${path}`);
  for (const [name, one] of Object.entries(params)) url.searchParams.append(name, one);
  const { body } = await createGoogleHttp({ tokens }).send({
    method: "GET",
    url: url.toString(),
    headers: {},
    timeoutMs: TIMEOUT_MS,
    kind: "read",
  });
  return isRecord(body) ? body : {};
}

type Copy = { threadId: string; labels: string[]; headers: Map<string, string>; text: string | null };

// A stored message as the read grant gets it: its thread, labels, headers by lower-case name,
// and its text/plain part with CRLF made LF.
async function copyOf(tokens: TokenSource, id: string): Promise<Copy> {
  const body = await get(tokens, `messages/${id}`, { format: "full" });
  const payload = isRecord(body.payload) ? body.payload : {};
  const headers = new Map<string, string>();
  for (const one of Array.isArray(payload.headers) ? payload.headers : [])
    if (isRecord(one)) headers.set(String(one.name).toLowerCase(), String(one.value));
  const plain = (part: Record<string, unknown>): string | null => {
    if (part.mimeType === "text/plain" && isRecord(part.body) && typeof part.body.data === "string")
      return Buffer.from(part.body.data, "base64url").toString("utf8").replaceAll("\r\n", "\n");
    for (const child of Array.isArray(part.parts) ? part.parts : []) if (isRecord(child)) return plain(child);
    return null;
  };
  return {
    threadId: String(body.threadId ?? ""),
    labels: (Array.isArray(body.labelIds) ? body.labelIds : []).map(String),
    headers,
    text: plain(payload),
  };
}

// RFC 2047 encoded words, as renderMessage writes a subject that is not ASCII.
const decodeWords = (value: string): string =>
  value.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=(?:\s+(?==\?UTF-8\?B\?))?/gi, (_, encoded: string) =>
    Buffer.from(encoded, "base64").toString("utf8"),
  );
const addresses = (value: string | undefined): string[] =>
  (value ?? "").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+/g) ?? [];

// One send to the account itself, through the package's send path, as `pi send` makes it.
async function sendOne(
  sendRefresh: string,
  from: string,
  to: string,
  subject: string,
  body: string,
  thread: SendPayload["thread"] = null,
) {
  const accessToken = await sendTokens(sendRefresh).accessToken();
  const payload: SendPayload = {
    v: 1,
    account: "acc_01JABCDEFGHJKMNPQRSTVWXYZ0" as SendPayload["account"],
    to: [to],
    cc: [],
    subject,
    body,
    thread,
  };
  return {
    payload,
    result: await sendMessage(createSendHttp({ accessToken }), renderMessage(payload, from), thread?.id),
  };
}

async function sentIds(tokens: TokenSource): Promise<string[]> {
  const body = await get(tokens, "messages", { labelIds: "SENT", maxResults: "50" });
  return (Array.isArray(body.messages) ? body.messages : []).flatMap((one) =>
    isRecord(one) && typeof one.id === "string" ? [one.id] : [],
  );
}

async function ask(question: string): Promise<boolean> {
  return (await terminal.question(`${question} [y/N] `)).trim().toLowerCase().startsWith("y");
}

async function main(): Promise<void> {
  say("The live send check. Use a throwaway Google account only.");
  const readRefresh = await consent(
    "mail",
    read,
    "Read consent: open this URL in a browser signed in to the throwaway account:",
  );
  keep("read", readRefresh);
  const reading = readTokens(readRefresh);
  const { address, historyId } = await gmailProfile(createGoogleHttp({ tokens: reading }));

  // The send consent, on the send client, refused unless exactly the send scopes were granted.
  let sendRefresh: string | null = null;
  try {
    sendRefresh = await consent(
      "send",
      send,
      "Send consent: open this URL in the same browser and approve sending:",
      address,
    );
    keep("send", sendRefresh);
    record("send_scope_set_exact", "ok");
  } catch (error) {
    say(JSON.stringify({ event: "send_consent_failed", code: error instanceof GoogleError ? error.code : "error" }));
    record("send_scope_set_exact", "failed");
  }
  if (sendRefresh === null) return;
  const refreshed = await refreshScopes(send, sendRefresh);
  record(
    "send_refresh_scope_exact",
    refreshed.status === 200 && refreshed.scopes !== null && sameSet(refreshed.scopes, SEND_GRANTED) ? "ok" : "failed",
  );

  // A consent by another account is refused with wrong_account, and stores nothing.
  if (await ask("Is a second throwaway account signed in to the browser, to check a consent by another account?")) {
    try {
      await consent("send", send, "Approve sending with the SECOND account this time:", address);
      record("consent_by_other_account_refused", "failed");
    } catch (error) {
      record(
        "consent_by_other_account_refused",
        error instanceof GoogleError && error.code === "wrong_account" ? "ok" : "failed",
      );
    }
  } else record("consent_by_other_account_refused", "skipped");

  // A first message, with the read grant's history before it.
  const first = await sendOne(sendRefresh, address, address, SUBJECT, HARD_BODY);
  record("send_scope_alone_accepted", first.result.outcome === "sent" ? "ok" : "failed");
  if (first.result.outcome !== "sent") return;
  const firstId = first.result.id;
  const copy = await copyOf(reading, firstId);
  record(
    "sent_id_is_listed_id",
    copy.threadId !== "" && (first.result.threadId === null || first.result.threadId === copy.threadId)
      ? "ok"
      : "failed",
  );
  record(
    "sent_copy_listed_under_sent",
    copy.labels.includes("SENT") && (await sentIds(reading)).includes(firstId) ? "ok" : "failed",
  );
  let arrived = false;
  for (const started = Date.now(); !arrived && Date.now() - started < ARRIVAL_MS; await sleep(5_000)) {
    const history = await get(reading, "history", { startHistoryId: historyId, historyTypes: "messageAdded" });
    arrived = (Array.isArray(history.history) ? history.history : []).some(
      (one) =>
        isRecord(one) &&
        Array.isArray(one.messagesAdded) &&
        one.messagesAdded.some((added) => isRecord(added) && isRecord(added.message) && added.message.id === firstId),
    );
  }
  record("sent_copy_arrives_by_history", arrived ? "ok" : "failed");
  record(
    "sent_copy_body_hash_matches",
    copy.text !== null && (await messageBodyHash(copy.text)) === (await messageBodyHash(HARD_BODY)) ? "ok" : "failed",
  );
  record(
    "sent_copy_recipients_match",
    sameSet(addresses(copy.headers.get("to")), first.payload.to) && addresses(copy.headers.get("cc")).length === 0
      ? "ok"
      : "failed",
  );
  record("subject_round_trips", decodeWords(copy.headers.get("subject") ?? "") === SUBJECT ? "ok" : "failed");
  record(
    "send_from_is_account",
    sameSet(addresses(copy.headers.get("from")), [address.toLowerCase()]) ? "ok" : "failed",
  );

  // A reply on the first message's thread, with its Message-ID and the derived subject.
  const messageId = copy.headers.get("message-id") ?? "";
  const reply = await sendOne(sendRefresh, address, address, `Re: ${SUBJECT}`, "A reply on the thread.", {
    id: copy.threadId,
    inReplyTo: messageId,
    references: [messageId],
  });
  record("send_with_thread_id_accepted", reply.result.outcome === "sent" ? "ok" : "failed");
  record(
    "reply_threads",
    reply.result.outcome === "sent" && (await copyOf(reading, reply.result.id)).threadId === copy.threadId
      ? "ok"
      : "failed",
  );

  // A From that is not the account's: replaced, not refused (for information).
  const other = await sendOne(
    sendRefresh,
    "not-the-account@example.com",
    address,
    "A rewritten sender",
    "Which sender is kept?",
  );
  record(
    "send_from_other_address_is_rewritten",
    other.result.outcome === "sent" &&
      sameSet(addresses((await copyOf(reading, other.result.id)).headers.get("from")), [address.toLowerCase()])
      ? "ok"
      : "failed",
  );

  // A send answered 4xx, a thread id that does not exist, leaves nothing under SENT.
  const sentBefore = await sentIds(reading);
  const refused = await sendOne(sendRefresh, address, address, "Refused", "This should not be stored.", {
    id: "ffffffffffffffff",
    inReplyTo: "<nothing@example.com>",
    references: [],
  });
  await sleep(10_000);
  const sentAfter = await sentIds(reading);
  record(
    "send_4xx_leaves_nothing_under_sent",
    refused.result.outcome === "failed" && sentAfter.filter((id) => !sentBefore.includes(id)).length === 0
      ? "ok"
      : "failed",
  );

  // The read grant after the send consent: it works, and a refresh names exactly the read scopes.
  record(
    "read_grant_unchanged",
    (await gmailProfile(createGoogleHttp({ tokens: readTokens(readRefresh) }))).address === address ? "ok" : "failed",
  );
  const readRefreshed = await refreshScopes(read, readRefresh);
  record(
    "read_refresh_scope_unchanged_after_send_consent",
    readRefreshed.status === 200 && readRefreshed.scopes !== null && sameSet(readRefreshed.scopes, GOOGLE_SCOPES)
      ? "ok"
      : "failed",
  );

  // Revoking the send token: 200, the send token then fails, and the read token still works.
  const revoked = await revokeSendToken(sendRefresh);
  await sleep(5_000);
  const sendGone = (await refreshScopes(send, sendRefresh)).status !== 200;
  const readStays = (await refreshScopes(read, readRefresh)).status === 200;
  record("revoking_send_token_leaves_read", revoked && sendGone && readStays ? "ok" : "failed");

  // What removing the app's access at Google's own page ends (for information).
  if (await ask("Check what removing the send app's access at Google's page ends? It needs one more send consent.")) {
    const again = await consent("send", send, "Send consent again, in the same browser:", address);
    keep("send", again);
    say("Now open https://myaccount.google.com/permissions, remove the access of the SEND app only, then press Enter.");
    await terminal.question("");
    const sendEnded = (await refreshScopes(send, again)).status !== 200;
    const readKept = (await refreshScopes(read, readRefresh)).status === 200;
    record("removing_app_access_scope", sendEnded && readKept ? "ok" : "failed");
  } else record("removing_app_access_scope", "skipped");

  // The send consent made on the read client: are the two consents still apart (for information)?
  if (await ask("Check a send consent made on the read client's project?")) {
    try {
      const same = await consent("send", read, "Send consent on the READ client, in the same browser:", address);
      keep("same", same);
      const sendWorks = (await refreshScopes(read, same)).status === 200;
      const readScopes = await refreshScopes(read, readRefresh);
      const apart =
        sendWorks &&
        readScopes.status === 200 &&
        readScopes.scopes !== null &&
        sameSet(readScopes.scopes, GOOGLE_SCOPES);
      await revokeSendToken(same);
      await sleep(5_000);
      record(
        "one_client_keeps_consents_apart",
        apart && (await refreshScopes(read, readRefresh)).status === 200 ? "ok" : "failed",
      );
    } catch {
      record("one_client_keeps_consents_apart", "failed");
    }
  } else record("one_client_keeps_consents_apart", "skipped");
}

try {
  await main().catch((error: unknown) =>
    say(JSON.stringify({ event: "check_stopped", code: error instanceof GoogleError ? error.code : "error" })),
  );
} finally {
  // Every line, in the table's order: a line the run did not reach failed.
  for (const name of LINES)
    say(JSON.stringify({ event: "check_result", check: name, result: results.get(name) ?? "failed" }));
  rmSync(TOKEN_FILE, { force: true });
  terminal.close();
}
