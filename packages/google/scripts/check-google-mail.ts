// The live Google check's default mode, mail and calendar: the Gmail survey and passes, the
// first run, and the rerun eight or more days later that checks the kept token still refreshes.

import { rmSync } from "node:fs";
import { derivingLabels } from "@intelligence/personal-core/items";
import {
  createGoogleConnector,
  createGoogleHttp,
  exchangeCode,
  GoogleError,
  gmailProfile,
  MAX_ANSWER_BYTES,
  pkcePair,
  tokenSource,
} from "@intelligence/personal-google";
import type { Cursor, Kept, Outcome, Page, Params, Result } from "./check-google-kit.ts";
import {
  account,
  check,
  clientId,
  clientSecret,
  consent,
  DAY_MS,
  direct,
  isRecord,
  keepToken,
  line,
  listAll,
  listOf,
  MAX_PAGES,
  PACE_RUN_MS,
  paced,
  portGet,
  refused,
  say,
  sleep,
  step,
  strings,
  TIMEOUT_MS,
  TOKEN_FILE,
  terminal,
} from "./check-google-kit.ts";
import {
  beyondAscii,
  charsetOf,
  hasAttachmentId,
  hasData,
  headerValues,
  isText,
  partsOf,
  readsAsUtf8,
  sizeOf,
} from "./check-google-mail-parts.ts";

// What the survey reads of each message: format=minimal, which carries no header and no text.
type Surveyed = { threadId: string; labels: string[]; at: number; size: number };

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DAY_SECONDS = 86_400;
const LAG_WAIT_MS = 60_000;
// A plain text part larger than this is the "over 1 MB" message this check sends and reads back.
const LARGE_TEXT_BYTES = 1_000_000;
// How far a window's split second stays from either message beside it.
const SPLIT_MARGIN_MS = 500;
const R2_HEADERS = [
  "From",
  "To",
  "Cc",
  "Bcc",
  "Date",
  "Subject",
  "Message-ID",
  "In-Reply-To",
  "References",
  "List-Unsubscribe",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
];

function gmailUrl(path: string, params: Params): string {
  const url = new URL(`${GMAIL}/${path}`);
  for (const [name, value] of params) url.searchParams.append(name, value);
  return url.toString();
}

// A token request the package never sends: one without client_secret. Only its status is
// read; whatever it answers, a token included, is dropped.
async function tokenPost(fields: Record<string, string>): Promise<number> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await response.text();
  return response.status;
}

// A check that needs a consent of its own, so the owner may skip it.
const offered = async (what: string): Promise<boolean> =>
  (
    await terminal.question(
      `Run the ${what} check? It needs another consent. Type yes to run it, or press Enter to skip: `,
    )
  )
    .trim()
    .toLowerCase() === "yes";

// An empty list is left out or sent as a list: either reads as empty.
const emptyShape = (body: unknown, key: string): Result =>
  isRecord(body) && (body[key] === undefined || Array.isArray(body[key])) ? "yes" : "no";
const payloadText = (payload: string): string => Buffer.from(payload, "base64").toString("utf8");

// Every id one listing names, page by page, to its end or the page cap. `ended` is false when
// the cap cut it short. The ids stay in memory and are only ever counted.
async function listIds(
  get: (url: string) => Promise<unknown>,
  params: Params,
): Promise<{ ids: Set<string>; ended: boolean }> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const body = await get(
      gmailUrl("messages", [
        ["includeSpamTrash", "true"],
        ...params,
        ["maxResults", "500"],
        ...(pageToken === undefined ? [] : [["pageToken", pageToken] satisfies [string, string]]),
      ]),
    );
    if (!isRecord(body)) throw new GoogleError("bad_response");
    for (const one of listOf(body.messages)) if (isRecord(one) && typeof one.id === "string") ids.add(one.id);
    if (typeof body.nextPageToken !== "string") return { ids, ended: true };
    pageToken = body.nextPageToken;
  }
  return { ids, ended: false };
}

// The connector's three passes, as fixed strings: the window's start, or its split, in whole epoch
// seconds, and nothing else.
const sentPass = (after: number): Params => [
  ["labelIds", "SENT"],
  ["q", `after:${after} -in:spam`],
];
const restPass = (after: number): Params => [["q", `after:${after} -in:sent -in:spam -category:promotions`]];
const olderPass = (after: number): Params => [["q", `before:${after + DAY_SECONDS} -in:spam`]];

const junk = (labels: string[]): boolean =>
  labels.includes("SPAM") || (labels.includes("CATEGORY_PROMOTIONS") && !labels.includes("SENT"));
const missing = (expected: Iterable<string>, ...listed: Set<string>[]): number =>
  [...expected].filter((id) => !listed.some((set) => set.has(id))).length;
const differ = (expected: Set<string>, listed: Set<string>): number =>
  missing(expected, listed) + missing(listed, expected);

// The rerun, eight or more days after the first run: does the kept token still refresh, and does the first run's history id
// still answer.
export async function rerun(kept: Kept): Promise<number> {
  const days = Math.floor((Date.now() - kept.issuedAt) / DAY_MS);
  const tokens = tokenSource({ grant: "mail", clientId, clientSecret, refreshToken: kept.refreshToken });
  const seen: { token: "alive" | "refused" | "stale" | "unknown"; historyAnswered: boolean } = {
    token: "unknown",
    historyAnswered: false,
  };
  await check("refresh_token_alive", async () => {
    try {
      await tokens.accessToken();
      seen.token = "alive";
      return ["yes", days];
    } catch (error) {
      // A token granted under another scope, by an earlier version of this script: no answer
      // about this one.
      if (error instanceof GoogleError && error.code === "scope_mismatch") {
        seen.token = "stale";
        return "not_observed";
      }
      // Only Google's refusal is an answer. Anything else is tried again on another run.
      if (!(error instanceof GoogleError) || error.code !== "oauth_failed") throw error;
      seen.token = "refused";
      return ["no", days];
    }
  });
  // The count is its age in days.
  await check("gmail_history_id_alive_after_a_day", async () => {
    if (seen.token !== "alive" || kept.historyId === null) return "not_observed";
    try {
      await portGet(
        createGoogleHttp({ tokens }),
        gmailUrl("history", [
          ["startHistoryId", kept.historyId],
          ["historyTypes", "messageAdded"],
          ["maxResults", "1"],
        ]),
      );
      seen.historyAnswered = true;
      return ["yes", days];
    } catch (error) {
      if (!(error instanceof GoogleError) || error.code !== "not_found") throw error;
      seen.historyAnswered = true;
      return ["no", days];
    }
  });
  if (seen.token === "stale") {
    line({ event: "token_file_stale" });
    say(
      "The token file was written under another scope. Delete $HOME/.config/pi-check/token.json and run this script again for a new first run.",
    );
    return 2;
  }
  if (seen.token === "alive" && days >= 8 && kept.historyId !== null && !seen.historyAnswered) {
    say("The history id got no answer this time. The token file is kept: run this script again.");
    return 1;
  }
  if (seen.token === "refused" || (seen.token === "alive" && days >= 8)) rmSync(TOKEN_FILE);
  return seen.token === "alive" ? 0 : 1;
}

export async function firstRun(): Promise<number> {
  // The consent and the exchange, with client_secret and the PKCE verifier.
  const granted = await consent();
  const grant = { refreshToken: "", mismatch: false };
  await check("exchange_with_client_secret", async (): Promise<Outcome> => {
    try {
      grant.refreshToken = (
        await exchangeCode({
          grant: "mail",
          clientId,
          clientSecret,
          code: granted.code,
          redirectUri: granted.redirectUri,
          codeVerifier: granted.verifier,
        })
      ).refreshToken;
    } catch (error) {
      // Google accepted the exchange; the package refused what it granted.
      if (!(error instanceof GoogleError) || error.code !== "scope_mismatch") throw error;
      grant.mismatch = true;
    }
    return "yes";
  });
  // Whether the grant held exactly gmail.readonly and the calendar scope, on an account with
  // no earlier grant.
  await check("grant_scopes_exact", () => (grant.mismatch ? "no" : grant.refreshToken === "" ? "not_observed" : "yes"));
  const { refreshToken } = grant;
  if (refreshToken === "") return 1;
  keepToken(refreshToken, null);

  // The token source sees each refresh answer on its way, and notes only whether it carries
  // `scope`; the answer itself goes on to the package unchanged.
  const refresh: { carriesScope: boolean | null } = { carriesScope: null };
  const observing: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const answer: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    if (isRecord(answer) && "access_token" in answer) refresh.carriesScope = "scope" in answer;
    return response;
  };
  const tokens = tokenSource({ grant: "mail", clientId, clientSecret, refreshToken }, { fetch: observing });
  await check("refresh_token_alive", async () => {
    await tokens.accessToken();
    return ["yes", 0];
  });
  await check("refresh_answer_carries_scope", () =>
    refresh.carriesScope === null ? "not_observed" : refresh.carriesScope ? "yes" : "no",
  );

  // A code is exchanged once, so it needs a consent of its own.
  const wrongVerifier = await offered("wrong-verifier");
  await check("wrong_verifier_refused", async () => {
    if (!wrongVerifier) return "not_observed";
    const second = await consent();
    try {
      await exchangeCode({
        grant: "mail",
        clientId,
        clientSecret,
        code: second.code,
        redirectUri: second.redirectUri,
        codeVerifier: pkcePair().verifier,
      });
      return "no";
    } catch (error) {
      if (error instanceof GoogleError && error.code === "oauth_failed") return "yes";
      throw error;
    }
  });

  // A token request without client_secret: Google wants it for a Desktop client. The code
  // exchange, with the right verifier and a consent of its own; then the refresh.
  const withoutSecret = await offered("exchange-without-client-secret");
  await check("exchange_without_client_secret_refused", async () => {
    if (!withoutSecret) return "not_observed";
    const third = await consent();
    return refused(
      await tokenPost({
        grant_type: "authorization_code",
        code: third.code,
        client_id: clientId,
        redirect_uri: third.redirectUri,
        code_verifier: third.verifier,
      }),
      400,
      401,
    );
  });
  await check("refresh_without_client_secret_refused", async () =>
    refused(
      await tokenPost({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
      400,
      401,
    ),
  );

  const http = createGoogleHttp({ tokens });
  const get = (url: string): Promise<unknown> => portGet(http, url);
  // The account's own address, held for the spoofed-From check and never written; and the
  // history id the rerun asks for again.
  const profile = await step("gmail_profile", () => gmailProfile(http));
  if (profile !== null) keepToken(refreshToken, profile.historyId);

  const surveyed = new Map<string, Surveyed>();
  const everything = await step("gmail_survey", async () => {
    const all = await listIds(async (url) => {
      const { status, body } = await direct(tokens, url);
      if (status !== 200) throw new GoogleError(status === 403 ? "forbidden" : "bad_response", status);
      return body;
    }, []);
    // A mailbox past the page cap is not a throwaway one: the survey is not taken.
    if (!all.ended) throw new GoogleError("too_large");
    for (const id of all.ids) {
      await paced();
      const body = await get(gmailUrl(`messages/${encodeURIComponent(id)}`, [["format", "minimal"]]));
      if (!isRecord(body)) continue;
      const at = Number(body.internalDate);
      surveyed.set(id, {
        threadId: String(body.threadId),
        labels: strings(body.labelIds),
        at,
        size: Number(body.sizeEstimate),
      });
    }
    return all.ids;
  });
  const survey = everything === null ? [] : [...surveyed.entries()];
  const idsWhere = (keep: (message: Surveyed) => boolean): Set<string> =>
    new Set(survey.filter(([, message]) => keep(message)).map(([id]) => id));
  const times = survey.map(([, message]) => message.at).sort((a, b) => a - b);
  // A window that holds the whole mailbox, a day before its oldest message.
  const whole = times.length === 0 ? null : Math.floor((times[0] ?? 0) / 1000) - DAY_SECONDS;
  // A window start between two messages: a whole second, in the widest gap between two
  // messages' times, at least SPLIT_MARGIN_MS from both, so neither time is near it. With no
  // such second, null, and the checks that need it report not_observed.
  const split = ((): number | null => {
    let best: { gap: number; at: number } | null = null;
    for (let index = 1; index < times.length; index += 1) {
      const before = times[index - 1] ?? 0;
      const after = times[index] ?? 0;
      const lowest = Math.ceil((before + SPLIT_MARGIN_MS) / 1000);
      const highest = Math.floor((after - SPLIT_MARGIN_MS) / 1000);
      if (lowest > highest || (best !== null && after - before <= best.gap)) continue;
      best = { gap: after - before, at: Math.min(highest, Math.max(lowest, Math.round((before + after) / 2000))) };
    }
    return best?.at ?? null;
  })();

  const passes: { sent: Set<string> | null; rest: Set<string> | null } = { sent: null, rest: null };
  await check("gmail_query_accepted", async () => {
    if (whole === null) return "not_observed";
    try {
      passes.rest = (await listIds(get, restPass(whole))).ids;
    } catch (error) {
      if (error instanceof GoogleError && (error.code === "forbidden" || error.code === "bad_response")) return "no";
      throw error;
    }
    passes.sent = (await listIds(get, sentPass(whole))).ids;
    return "yes";
  });
  // The count is the ids listed that should not be, and those not listed that should.
  await check("gmail_after_epoch_bounds_by_received_time", async () => {
    if (split === null) return "not_observed";
    const listed = (await listIds(get, [["q", `after:${split}`]])).ids;
    const count = differ(
      idsWhere((message) => message.at > split * 1000),
      listed,
    );
    return [count === 0 ? "yes" : "no", count];
  });
  await check("gmail_sent_pass_lists_sent_only", () => {
    const expected = idsWhere((message) => message.labels.includes("SENT") && !message.labels.includes("SPAM"));
    if (passes.sent === null || expected.size === 0) return "not_observed";
    const count = differ(expected, passes.sent);
    return [count === 0 ? "yes" : "no", count];
  });
  // The count is the ids the rest pass listed that are under Spam or Promotions or carry SENT.
  await check("gmail_rest_pass_leaves_out_junk_and_sent", () => {
    const left = idsWhere((message) =>
      ["SPAM", "CATEGORY_PROMOTIONS", "SENT"].some((label) => message.labels.includes(label)),
    );
    if (passes.rest === null || left.size === 0) return "not_observed";
    const rest = passes.rest;
    const count = [...left].filter((id) => rest.has(id)).length;
    return [count === 0 ? "yes" : "no", count];
  });
  // The count is the trashed messages that are not junk and that neither fetching pass listed.
  await check("gmail_trash_listed_with_query", () => {
    const trashed = idsWhere((message) => message.labels.includes("TRASH") && !junk(message.labels));
    if (passes.sent === null || passes.rest === null || trashed.size === 0) return "not_observed";
    const count = missing(trashed, passes.sent, passes.rest);
    return [count === 0 ? "yes" : "no", count];
  });
  // Every id the listing with no query named, less the junk ones, against the two passes.
  await check("gmail_passes_cover_mailbox", () => {
    if (passes.sent === null || passes.rest === null || survey.length === 0) return "not_observed";
    const count = missing(
      idsWhere((message) => !junk(message.labels)),
      passes.sent,
      passes.rest,
    );
    return [count === 0 ? "yes" : "no", count];
  });
  // With the window starting at the split: the two fetching passes and the older pass against
  // every id a reconciling listing must name. That is every id not under Spam, less a junk
  // message inside the window, which is never stored, so its absence removes nothing. A reset
  // on the owner's mail waits for this count to be 0.
  await check("gmail_before_and_after_cover_mailbox", async () => {
    if (split === null) return "not_observed";
    const named = await Promise.all(
      [sentPass(split), restPass(split), olderPass(split)].map(async (params) => (await listIds(get, params)).ids),
    );
    const expected = idsWhere(
      (message) => !message.labels.includes("SPAM") && !(junk(message.labels) && message.at > split * 1000),
    );
    const count = missing(expected, ...named);
    return [count === 0 ? "yes" : "no", count];
  });

  // The format=full answers, each read once, with the size of each answer as it came.
  const answers: { largest: number; full: unknown[] } = { largest: 0, full: [] };
  const measuring: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const bytes = new Uint8Array(await response.arrayBuffer());
    answers.largest = Math.max(answers.largest, bytes.byteLength);
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const measured = createGoogleHttp({ tokens, deps: { fetch: measuring } });
  const fullRead = await step("gmail_full_answers", async () => {
    for (const [id] of survey) {
      await paced();
      try {
        answers.full.push(
          await portGet(measured, gmailUrl(`messages/${encodeURIComponent(id)}`, [["format", "full"]])),
        );
      } catch (error) {
        // An answer over the bound is still measured; the next message is read.
        if (!(error instanceof GoogleError) || error.code !== "too_large") throw error;
      }
    }
    return true;
  });
  const payloads =
    fullRead === null
      ? []
      : answers.full.flatMap((answer) => (isRecord(answer) && isRecord(answer.payload) ? [answer.payload] : []));
  const parts = payloads.flatMap(partsOf);
  const allHeaders = payloads.map((payload) => listOf(payload.headers));

  // The count is those that do not.
  await check("gmail_full_text_parts_carry_data", () => {
    const texts = parts.filter((part) => isText(part) && sizeOf(part) > 0 && sizeOf(part) <= LARGE_TEXT_BYTES);
    if (texts.length === 0) return "not_observed";
    const count = texts.filter((part) => !hasData(part)).length;
    return [count === 0 ? "yes" : "no", count];
  });
  // The count is those with bytes.
  await check("gmail_full_attachment_has_no_bytes", () => {
    const attachments = parts.filter((part) => part.filename !== "");
    if (attachments.length === 0) return "not_observed";
    const count = attachments.filter((part) => hasData(part) || !hasAttachmentId(part)).length;
    return [count === 0 ? "yes" : "no", count];
  });
  // In-Reply-To and References need a reply to be seen.
  await check("gmail_full_headers_returned", () => {
    if (allHeaders.length === 0) return "not_observed";
    const seen = R2_HEADERS.filter((name) =>
      allHeaders.some((headers) => headerValues(headers, name).length > 0),
    ).length;
    return [allHeaders.every((headers) => headerValues(headers, "From").length > 0) ? "yes" : "no", seen];
  });
  // For information: whether a text part whose own charset is not UTF-8 is handed over as
  // UTF-8. Only a part with a byte beyond ASCII tests that. The count is such parts seen; with
  // none there is nothing to observe.
  await check("gmail_full_text_is_utf8", () => {
    const others = parts.filter(
      (part) =>
        isText(part) &&
        hasData(part) &&
        !["", "utf-8", "utf8", "us-ascii"].includes(charsetOf(part)) &&
        beyondAscii(part),
    );
    if (others.length === 0) return "not_observed";
    return [others.every(readsAsUtf8) ? "yes" : "no", others.length];
  });
  await check("gmail_full_answer_within_bound", () =>
    fullRead === null || answers.largest === 0
      ? "not_observed"
      : [answers.largest <= MAX_ANSWER_BYTES ? "yes" : "no", answers.largest],
  );
  // The count is that part's size in bytes.
  await check("gmail_large_text_part_has_data", () => {
    const large = parts.find(
      (part) => part.filename === "" && part.mimeType === "text/plain" && sizeOf(part) > LARGE_TEXT_BYTES,
    );
    if (large === undefined) return "not_observed";
    if (hasData(large)) return ["yes", sizeOf(large)];
    return hasAttachmentId(large) ? ["no", sizeOf(large)] : "not_observed";
  });

  // Names as RFC 2047 encoded words (yes), as raw non-ASCII text (no), or no such name seen.
  await check("gmail_names_encoded_words", () => {
    const from = allHeaders.flatMap((headers) => headerValues(headers, "From"));
    if (from.some((value) => value.includes("=?"))) return "yes";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the class spans the whole ASCII range, control characters included, so anything outside it is non-ASCII
    return from.some((value) => /[^\x00-\x7f]/.test(value)) ? "no" : "not_observed";
  });
  // Whether Gmail delivers a second message that reuses a Message-ID already in the mailbox.
  // This script cannot send mail, so it only sees it when the mailbox already holds such a
  // pair; the count is the messages beyond the first of each Message-ID.
  await check("gmail_reused_message_id_delivered", () => {
    const ids = allHeaders.flatMap((headers) => headerValues(headers, "Message-ID").map((value) => value.trim()));
    const reused = ids.length - new Set(ids).size;
    return reused > 0 ? ["yes", reused] : "not_observed";
  });

  await check("gmail_metadata_format_served", async () => {
    const [first] = survey;
    if (first === undefined) return "not_observed";
    await paced();
    try {
      const body = await get(
        gmailUrl(`messages/${encodeURIComponent(first[0])}`, [
          ["format", "metadata"],
          ...R2_HEADERS.map((name): [string, string] => ["metadataHeaders", name]),
        ]),
      );
      return isRecord(body) && isRecord(body.payload) && Array.isArray(body.payload.headers) ? "yes" : "no";
    } catch (error) {
      if (error instanceof GoogleError && (error.code === "forbidden" || error.code === "bad_response")) return "no";
      throw error;
    }
  });
  // The count is the thread's messages.
  await check("gmail_thread_minimal_lists_ids_and_labels", async () => {
    const sizes = new Map<string, number>();
    for (const [, message] of survey) sizes.set(message.threadId, (sizes.get(message.threadId) ?? 0) + 1);
    const thread = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (thread === undefined) return "not_observed";
    const body = await get(gmailUrl(`threads/${encodeURIComponent(thread)}`, [["format", "minimal"]]));
    const messages = isRecord(body) ? listOf(body.messages) : [];
    const minimal =
      messages.length > 0 &&
      messages.every(
        (one) =>
          isRecord(one) && typeof one.id === "string" && Array.isArray(one.labelIds) && one.payload === undefined,
      );
    return [minimal ? "yes" : "no", messages.length];
  });
  // For information: whether sent mail carries a category. The count is such messages.
  await check("gmail_sent_carries_category", () => {
    const sent = survey.filter(([, message]) => message.labels.includes("SENT"));
    if (sent.length === 0) return "not_observed";
    const count = sent.filter(([, message]) => message.labels.some((label) => label.startsWith("CATEGORY_"))).length;
    return [count > 0 ? "yes" : "no", count];
  });
  // Whether Gmail gives SENT to a message from outside whose From is the account's own address.
  // The owner names it by one word of its subject, typed here; the word goes into one search
  // and is never written. The count is how many such messages also carry SPAM: yes with a count
  // below the messages found is a spoofed message read as the owner's.
  const word = (
    await terminal.question(
      "If you sent this account a message from outside with its own address as From, type one word of letters and digits that appears in that message's subject and in no other's. It is used in one search and never written. Press Enter to skip: ",
    )
  ).trim();
  await check("gmail_spoofed_from_labels", async () => {
    if (!/^[A-Za-z0-9]{3,40}$/.test(word) || profile === null) return "not_observed";
    const own = profile.address.toLowerCase();
    const found = await listIds(get, [["q", `subject:${word}`]]);
    const spoofed: string[][] = [];
    for (const id of found.ids) {
      await paced();
      const body = await get(
        gmailUrl(`messages/${encodeURIComponent(id)}`, [
          ["format", "metadata"],
          ["metadataHeaders", "From"],
        ]),
      );
      if (!isRecord(body) || !isRecord(body.payload)) continue;
      if (headerValues(listOf(body.payload.headers), "From").some((value) => value.toLowerCase().includes(own)))
        spoofed.push(strings(body.labelIds));
    }
    if (spoofed.length === 0) return "not_observed";
    return [
      spoofed.some((labels) => labels.includes("SENT")) ? "yes" : "no",
      spoofed.filter((labels) => labels.includes("SPAM")).length,
    ];
  });

  // The count is the answers that were a 429 or a 403, which must be 0.
  await check("gmail_pace_within_quota", async () => {
    if (survey.length === 0) return "not_observed";
    let limited = 0;
    const counting: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (response.status === 429 || response.status === 403) limited += 1;
      return response;
    };
    const quota = createGoogleHttp({ tokens, deps: { fetch: counting } });
    const end = Date.now() + PACE_RUN_MS;
    for (let index = 0; Date.now() < end; index += 1) {
      await paced();
      const [id] = survey[index % survey.length] ?? [""];
      try {
        await portGet(quota, gmailUrl(`messages/${encodeURIComponent(id)}`, [["format", "minimal"]]));
      } catch (error) {
        if (!(error instanceof GoogleError) || error.code !== "rate_limited") throw error;
      }
    }
    return [limited === 0 ? "yes" : "no", limited];
  });

  // A 200 means Gmail still holds that history.
  await check("gmail_expired_history_is_404", async () => {
    const { status } = await direct(tokens, `${GMAIL}/history?startHistoryId=1&historyTypes=messageAdded&maxResults=1`);
    return status === 404 ? "yes" : status === 200 ? "not_observed" : "no";
  });
  await check("gmail_absent_lists_are_empty", async () => {
    const { historyId } = await gmailProfile(http);
    const history = await direct(
      tokens,
      `${GMAIL}/history?startHistoryId=${encodeURIComponent(historyId)}&historyTypes=messageAdded`,
    );
    const drafts = await direct(tokens, `${GMAIL}/messages?labelIds=DRAFT&maxResults=1`);
    if (history.status !== 200 || drafts.status !== 200) return "not_observed";
    return emptyShape(history.body, "history") === "yes" && emptyShape(drafts.body, "messages") === "yes"
      ? "yes"
      : "no";
  });

  const mail = account("google_mail", "acc_00000000000000000000000001");
  const calendar = account("google_calendar", "acc_00000000000000000000000002");
  const since = new Date(Date.now() - 90 * DAY_MS).toISOString();
  // No since: the whole of this small mailbox, to its end.
  const gmail = createGoogleConnector("google_mail", mail.credential, http);
  const events = createGoogleConnector("google_calendar", calendar.credential, http, { since });

  // Gmail: a first listing through the connector, for the history id it ends at.
  const listed = await step("gmail_listing", () => listAll(gmail, mail.account, 500));
  const historyCursor: Cursor | null = listed?.ended ? listed.next : null;

  // Calendar: how far an endless daily event is expanded with no timeMax.
  let syncCursor: Cursor | null = null;
  await check("calendar_expansion_bounded", async () => {
    const listing = await listAll(events, calendar.account, 250);
    if (listing.ended) syncCursor = listing.next;
    const starts = listing.pages
      .flatMap((page) => page.items)
      .flatMap((item) => {
        const event: unknown = JSON.parse(payloadText(item.payload));
        const start = isRecord(event) && isRecord(event.start) ? (event.start.dateTime ?? event.start.date) : undefined;
        const at = typeof start === "string" ? Date.parse(start) : Number.NaN;
        return Number.isNaN(at) ? [] : [at];
      });
    if (starts.length === 0) return "not_observed";
    // The count is the days from now to the latest instance start returned.
    return [listing.ended ? "yes" : "no", Math.round((Math.max(...starts) - Date.now()) / DAY_MS)];
  });

  // A sync token of this script's own, for the requests the connector never sends.
  let syncToken = "";
  await check("calendar_sync_refuses_time_min", async () => {
    let pageToken = "";
    for (let pages = 0; pages < MAX_PAGES && syncToken === ""; pages += 1) {
      const { status, body } = await direct(
        tokens,
        `${EVENTS}?singleEvents=true&maxResults=250&timeMin=${encodeURIComponent(since)}${pageToken === "" ? "" : `&pageToken=${encodeURIComponent(pageToken)}`}`,
      );
      if (status !== 200 || !isRecord(body)) break;
      if (typeof body.nextSyncToken === "string") syncToken = body.nextSyncToken;
      else if (typeof body.nextPageToken === "string") pageToken = body.nextPageToken;
      else break;
    }
    if (syncToken === "") return "not_observed";
    return refused(
      (
        await direct(
          tokens,
          `${EVENTS}?syncToken=${encodeURIComponent(syncToken)}&timeMin=${encodeURIComponent(since)}`,
        )
      ).status,
      400,
    );
  });
  await check("calendar_sync_refuses_order_by", async () => {
    if (syncToken === "") return "not_observed";
    return refused(
      (await direct(tokens, `${EVENTS}?syncToken=${encodeURIComponent(syncToken)}&orderBy=updated`)).status,
      400,
    );
  });
  // Only a 410 confirms the expiry answer.
  await check("calendar_expired_token_is_410", async () =>
    (await direct(tokens, `${EVENTS}?syncToken=expired-check-token`)).status === 410 ? "yes" : "not_observed",
  );

  say(
    "Now, in the throwaway account: send it one new message from another account, delete one message permanently (empty it from the trash), and edit the single event.",
  );
  await terminal.question("Press Enter when all three are done: ");

  // Gmail history under gmail.readonly, with the added and the deleted message.
  let changes: Page | null = null;
  await check("gmail_history_served", async () => {
    if (historyCursor === null) return "not_observed";
    changes = await gmail.listChanges(mail.account, historyCursor, 500);
    // A new listing here would mean the history id had expired, not that history was served.
    return changes.listing === undefined ? "yes" : "no";
  });
  const served = (): Page | null => (changes !== null && changes.listing === undefined ? changes : null);
  await check("gmail_history_shows_added", () => {
    const page = served();
    return page === null ? "not_observed" : [page.items.length > 0 ? "yes" : "no", page.items.length];
  });

  // The two fetching passes are listed at once after history showed the new message, and again a
  // minute later. Yes when the first call already listed every added message that is not junk; no
  // otherwise, with the count of those the first call missed and the second listed. No with a count
  // of 0 is a message still missing after a minute. A measurement: a count above 0 is a finding.
  await check("gmail_query_lists_new_message_at_once", async () => {
    const page = served();
    if (page === null || whole === null) return "not_observed";
    const added = page.items.map((item) => item.sourceItemId.replace(/^gmail-id:/, ""));
    if (added.length === 0) return "not_observed";
    const listPasses = async (): Promise<Set<string>[]> =>
      Promise.all([sentPass(whole), restPass(whole)].map(async (params) => (await listIds(get, params)).ids));
    const first = await listPasses();
    const kept: string[] = [];
    for (const id of added) {
      await paced();
      const body = await get(gmailUrl(`messages/${encodeURIComponent(id)}`, [["format", "minimal"]]));
      if (isRecord(body) && !junk(strings(body.labelIds))) kept.push(id);
    }
    if (kept.length === 0) return "not_observed";
    const late = kept.filter((id) => !first.some((set) => set.has(id)));
    if (late.length === 0) return ["yes", 0];
    await sleep(LAG_WAIT_MS);
    const second = await listPasses();
    return ["no", late.filter((id) => second.some((set) => set.has(id))).length];
  });
  await check("gmail_history_shows_deleted", () => {
    const page = served();
    return page === null ? "not_observed" : [page.deletions.length > 0 ? "yes" : "no", page.deletions.length];
  });

  // A sync token issued after a timeMin request, and the edited event through it.
  let edits: Page | null = null;
  await check("calendar_sync_after_time_min", async () => {
    if (syncCursor === null) return "not_observed";
    edits = await events.listChanges(calendar.account, syncCursor, 250);
    return edits.listing === undefined ? "yes" : "no";
  });
  await check("calendar_sync_returns_edit", () => {
    const page: Page | null = edits;
    if (page === null || page.listing !== undefined) return "not_observed";
    return [page.items.length > 0 ? "yes" : "no", page.items.length];
  });
  await check("calendar_absent_items_are_empty", async () => {
    if (syncToken === "") return "not_observed";
    const changed = await direct(tokens, `${EVENTS}?syncToken=${encodeURIComponent(syncToken)}`);
    const latest = isRecord(changed.body) ? changed.body.nextSyncToken : undefined;
    if (changed.status !== 200 || typeof latest !== "string") return "not_observed";
    const quiet = await direct(tokens, `${EVENTS}?syncToken=${encodeURIComponent(latest)}`);
    return quiet.status === 200 ? emptyShape(quiet.body, "items") : "not_observed";
  });

  // A label change under gmail.readonly: the connector's reading of one is written from Google's
  // reference alone. Where history stood before the change: the id for this script's own request,
  // and the connector's cursor past the changes it has already read.
  const read = served();
  const labelCursor: Cursor | null = read !== null && !read.more ? read.next : null;
  const labelStart = await gmailProfile(http).then(
    (latest) => latest.historyId,
    () => "",
  );
  say("Now, in the throwaway account, in the browser: move one message to Spam, or move one out of Spam to the inbox.");
  await terminal.question("Press Enter when it is done: ");

  // Whether history takes the two label types under this scope at all.
  let labelHistory: { status: number; body: unknown } | null = null;
  await check("gmail_history_label_types_accepted", async () => {
    if (labelStart === "") return "not_observed";
    labelHistory = await direct(
      tokens,
      `${GMAIL}/history?startHistoryId=${encodeURIComponent(labelStart)}&historyTypes=labelAdded&historyTypes=labelRemoved&maxResults=500`,
    );
    return labelHistory.status === 200
      ? "yes"
      : labelHistory.status === 400 || labelHistory.status === 403
        ? "no"
        : "not_observed";
  });
  // Whether a labelsAdded or labelsRemoved entry came back whose own labelIds include a
  // deriving label, as the connector expects of a move to or from Spam. The count is those
  // entries; a label is only ever counted, never written.
  await check("gmail_history_label_change_reported", () => {
    const answer: { status: number; body: unknown } | null = labelHistory;
    if (answer === null || answer.status !== 200 || !isRecord(answer.body)) return "not_observed";
    const records = listOf(answer.body.history);
    const entries = records
      .flatMap((record): unknown[] => (isRecord(record) ? [record.labelsAdded, record.labelsRemoved] : []))
      .flatMap(listOf);
    const deriving = entries.filter((entry) => isRecord(entry) && derivingLabels(strings(entry.labelIds)).length > 0);
    return [deriving.length > 0 ? "yes" : "no", deriving.length];
  });
  // Whether the connector's own page of that history hands the moved message over as an item.
  await check("gmail_label_change_handed_over", async () => {
    if (labelCursor === null) return "not_observed";
    const page = await gmail.listChanges(mail.account, labelCursor, 500);
    // A new listing here would mean the history id had expired.
    if (page.listing !== undefined) return "not_observed";
    return [page.items.length > 0 ? "yes" : "no", page.items.length];
  });

  // A 403 that is a rate limit cannot be provoked on a throwaway account.
  await check("rate_limit_403_reason", () => "not_observed");

  say(
    "Done. Run this script again in eight days, with the same two variables set, to check that the token still refreshes and the history id still answers.",
  );
  return 0;
}
