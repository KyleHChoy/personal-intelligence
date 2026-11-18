import type { IncomingMessage, ServerResponse } from "node:http";
import { CardId, type PersonalLogger } from "@intelligence/contracts/personal";
import { type Admin, AdminError, eventCursor } from "@intelligence/personal-store";
import { faultFields } from "../logger.ts";
import { answer, file, json, packed, readJson, WEB_HEADERS } from "./web-answer.ts";
import { POST_READ_CALLS, READ_CALLS, type ReadHost, WRITE_CALLS } from "./web-api.ts";
import { CEREMONY, type Step } from "./web-ceremony.ts";
import { type Client, linkRefusedShell } from "./web-client.ts";
import { forged, hostOf, type Tailscale } from "./web-guards.ts";
import { AS_WRITTEN, inOwnerWords } from "./web-names.ts";
import { NOT_HERE, POST_READS, READS, STREAMS, WRITES } from "./web-routes.ts";
import type { Session, Sessions } from "./web-sessions.ts";

// The dashboard's routing (web.ts): each request checked by its Host, then sent by its path to the
// link login, a passkey ceremony, the registry's reads, streams and writes (web-routes.ts), or the
// client's files.

// After a failed poll, the browser's wait before it opens the stream again.
const RETRY_MS = 60_000;
const snake = (name: string): string => name.replace(/[A-Z]/g, (one) => `_${one.toLowerCase()}`);

// A route's schema, as it is called here: the registry's are Zod's.
type Parse = { safeParse(value: unknown): { success: true; data: unknown } | { success: false } };
type Call = (admin: Admin, args: unknown, host?: ReadHost) => Promise<unknown>;

export type Routing = {
  admin: Admin;
  log: PersonalLogger;
  client: Client;
  tailscale: Tailscale | undefined;
  sessions: Sessions;
  ceremony: (request: IncomingMessage, response: ServerResponse, step: Step, host: string) => Promise<void>;
  eventsMs: number;
  driveCeilingBytes: number | undefined;
  afterWrite: () => Promise<void>;
};

export function createRouter({
  admin,
  log,
  client,
  tailscale,
  sessions,
  ceremony,
  eventsMs,
  driveCeilingBytes,
  afterWrite,
}: Routing): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  // The link login: a valid code once, within its minutes, starts the link's session, ending the
  // last one the link made. Any other code is refused alike, still 401 and with no session, with
  // the shell marked as a refused link, so the page lands on its sign-in screen saying so instead
  // of blank.
  const refusedShell = linkRefusedShell(client.shell.body);
  const startSession = (url: URL, secure: boolean, response: ServerResponse): void => {
    if (!sessions.codeOk("login", url.searchParams.get("code"))) {
      answer(response, 401, refusedShell, client.shell.type);
      return;
    }
    sessions.spend("login");
    answer(response, 303, "", undefined, { Location: "/", "Set-Cookie": sessions.open("link", secure) });
  };

  const read = async (
    request: IncomingMessage,
    response: ServerResponse,
    session: Session,
    name: keyof typeof READS,
    url: URL,
  ): Promise<void> => {
    if (request.headers["x-pi-action"] === "navigate") sessions.touch(session);
    // Ids, dates and codes, each named once, in the query.
    const names = [...url.searchParams.keys()];
    if (new Set(names).size !== names.length) return json(response, 400, { refused: "usage" });
    const args = (READS[name].args as Parse).safeParse(Object.fromEntries(url.searchParams));
    if (!args.success) return json(response, 400, { refused: "usage" });
    let result: unknown;
    const began = performance.now();
    try {
      result = await (READ_CALLS[name] as Call)(
        admin,
        args.data,
        driveCeilingBytes === undefined ? {} : { driveCeilingBytes },
      );
      // Each read's time, by its name and a count of milliseconds: what the owner waits on.
      log.info({ event: "web_read", code: snake(name), counts: { ms: Math.round(performance.now() - began) } });
    } catch (error) {
      // A read's own refusal, by its code: a cursor the server did not issue, an owner audience
      // being rebuilt.
      if (!(error instanceof AdminError)) throw error;
      log.warn({ event: "web_refused", code: error.code });
      return json(response, error.code === "not_found" ? 404 : error.code === "invalid_argument" ? 400 : 409, {
        refused: error.code,
      });
    }
    return served(request, response, name, READS[name].result as Parse, result);
  };

  // A read's answer, checked against the registry's shape, as the client will read it; compressed when
  // it is long and the browser accepts it. Only reads are: the session's form token and the passkey's
  // challenges go uncompressed, so no secret shares a compressed answer. Its text in the owner's words
  // first: every id an agent wrote, named in one batch.
  const served = async (
    request: IncomingMessage,
    response: ServerResponse,
    name: string,
    shape: Parse,
    result: unknown,
  ): Promise<void> => {
    if (result === null) return json(response, 404, { refused: "not_found" });
    let value: unknown;
    try {
      const parsed = JSON.parse(JSON.stringify(result)) as unknown;
      value = AS_WRITTEN.has(name) ? parsed : await inOwnerWords(parsed, (tokens) => admin.names.words(tokens));
    } catch (error) {
      // Never served with its ids: a naming that fails is the read's refusal, as its own would be.
      if (!(error instanceof AdminError)) throw error;
      log.warn({ event: "web_refused", code: error.code });
      return json(response, error.code === "not_found" ? 404 : 409, { refused: error.code });
    }
    if (!shape.safeParse(value).success) {
      log.error({ event: "web_bad_result", code: snake(name) });
      return json(response, 500, { refused: "unavailable" });
    }
    return packed(request, response, JSON.stringify(value));
  };

  // Never the owner's action: the stream keeps no session alive, and it ends when the session does, when
  // the page goes, or when a poll fails. Each event's `id` is the stream's high mark, so a reconnecting
  // browser's Last-Event-ID resumes after every event it was sent.
  const stream = async (
    request: IncomingMessage,
    response: ServerResponse,
    session: Session,
    url: URL,
  ): Promise<void> => {
    const names = [...url.searchParams.keys()];
    if (new Set(names).size !== names.length) return json(response, 400, { refused: "usage" });
    const args = (STREAMS.events.args as Parse).safeParse(Object.fromEntries(url.searchParams));
    if (!args.success) return json(response, 400, { refused: "usage" });
    const last = request.headers["last-event-id"];
    const given = (args.data as { after: number }).after;
    let cursor = eventCursor(
      typeof last === "string" && /^[0-9]{1,15}$/.test(last) ? Math.max(given, Number(last)) : given,
    );
    response.writeHead(200, { ...WEB_HEADERS, "Content-Type": "text/event-stream; charset=utf-8" });
    response.write(": open\n\n");
    let timer: NodeJS.Timeout | undefined;
    let ended = false;
    const end = (): void => {
      ended = true;
      clearTimeout(timer);
      if (!response.writableEnded) response.end();
    };
    response.on("close", end);
    const poll = async (): Promise<void> => {
      if (ended) return;
      if (!sessions.alive(session)) return end();
      try {
        const polled = await admin.ledger.events(cursor);
        cursor = polled.cursor;
        for (const event of polled.events) {
          if (ended) return;
          if (!(STREAMS.events.event as Parse).safeParse(event).success) {
            log.error({ event: "web_bad_result", code: "events" });
            continue;
          }
          response.write(`id: ${cursor.after}\nevent: ledger\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch (error) {
        log.error({ event: "web_failed", ...faultFields(error) });
        // The browser waits this long before it reconnects, not its 3 seconds.
        if (!response.writableEnded) response.write(`retry: ${RETRY_MS}\n\n`);
        return end();
      }
      if (!ended) timer = setTimeout(() => void poll(), eventsMs);
    };
    await poll();
  };

  // A read whose argument is free text (search): in the body, checked as a write is, and never
  // logged; only the read's name can reach a log line.
  const postRead = async (
    request: IncomingMessage,
    response: ServerResponse,
    session: Session,
    name: keyof typeof POST_READS,
    secure: boolean,
  ): Promise<void> => {
    if (forged(request, session, secure, tailscale)) {
      request.resume();
      return answer(response, 403);
    }
    if (request.headers["x-pi-action"] === "navigate") sessions.touch(session);
    const args = (POST_READS[name].args as Parse).safeParse(await readJson(request));
    if (!args.success) return json(response, 400, { refused: "usage" });
    return served(
      request,
      response,
      name,
      POST_READS[name].result as Parse,
      await (POST_READ_CALLS[name] as Call)(admin, args.data),
    );
  };

  // One write, one owner decision. The Origin, then the token, then the body, before anything is
  // written.
  const write = async (
    request: IncomingMessage,
    response: ServerResponse,
    session: Session,
    name: keyof typeof WRITES,
    secure: boolean,
  ): Promise<void> => {
    if (forged(request, session, secure, tailscale)) {
      request.resume();
      return answer(response, 403);
    }
    const body = (WRITES[name].body as Parse).safeParse(await readJson(request));
    if (!body.success) return json(response, 400, { refused: "usage" });
    sessions.touch(session);
    const card = name === "decide" ? CardId.safeParse((body.data as { card?: unknown }).card) : null;
    const ids = card?.success === true ? { ids: { card: card.data } } : {};
    try {
      const result = await (WRITE_CALLS[name] as Call)(admin, body.data).finally(() => {
        void afterWrite();
      });
      // A lift, a clear or a goal's change that found nothing in force wrote nothing: the command
      // it equals refuses it as not_found, and so does the page.
      if (result === false) {
        log.warn({ event: "web_refused", code: "not_found", ...ids });
        return json(response, 404, { refused: "not_found" });
      }
      log.info({ event: "web_written", code: snake(name), ...ids });
      json(response, 200, { result });
    } catch (error) {
      if (!(error instanceof AdminError)) throw error;
      log.warn({ event: "web_refused", code: error.code, ...ids });
      // The rulings in force that settle or conflict with it, as the command prints them, so the
      // page can show and lift them.
      json(response, error.code === "not_found" ? 404 : error.code === "invalid_argument" ? 400 : 409, {
        refused: error.code,
        ...(error.rulings === undefined ? {} : { rulings: error.rulings }),
      });
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const checked = hostOf(request, tailscale, log);
    if ("refused" in checked) return answer(response, checked.refused);
    const { host, secure } = checked;
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "";
    if (url.pathname === "/login")
      return method === "GET" ? startSession(url, secure, response) : answer(response, 405);
    if (Object.hasOwn(CEREMONY, url.pathname)) {
      if (!secure || method !== "POST") {
        request.resume();
        return answer(response, secure ? 405 : 404);
      }
      return ceremony(request, response, CEREMONY[url.pathname as keyof typeof CEREMONY], host);
    }
    const session = sessions.sessionOf(request);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      // Every route of the API needs a session: without one, 401 and an empty body.
      if (session === null) {
        request.resume();
        return answer(response, 401);
      }
      const name = url.pathname.slice("/api/".length);
      // The form token, for the client to send with each write.
      if (name === "session")
        return method === "GET" ? json(response, 200, { token: session.token }) : answer(response, 405);
      if (Object.hasOwn(READS, name))
        return method === "GET"
          ? read(request, response, session, name as keyof typeof READS, url)
          : answer(response, 405);
      if (Object.hasOwn(STREAMS, name))
        return method === "GET" ? stream(request, response, session, url) : answer(response, 405);
      // A free-text read is POST only, so its term is never in a URL; a GET reads nothing.
      if (Object.hasOwn(POST_READS, name)) {
        if (method === "POST") return postRead(request, response, session, name as keyof typeof POST_READS, secure);
        request.resume();
        return answer(response, 405);
      }
      if (Object.hasOwn(WRITES, name))
        return method === "POST"
          ? write(request, response, session, name as keyof typeof WRITES, secure)
          : answer(response, 405);
      request.resume();
      return json(response, 404, { refused: NOT_HERE });
    }
    // The client's files, which hold no data: with a session or without.
    if (method !== "GET") {
      request.resume();
      return answer(response, 405);
    }
    const asset = client.assets.get(url.pathname);
    if (asset !== undefined) return file(request, response, asset, url.pathname.startsWith("/assets/"));
    // A file under /assets/ this build does not hold (a tab open across a new build asks for the
    // last build's room): 404, never the shell, so the page says the room did not open.
    if (url.pathname.startsWith("/assets/")) return answer(response, 404);
    // A page: the shell. Loading it is the owner's navigation.
    if (session !== null) sessions.touch(session);
    file(request, response, client.shell, false);
  };

  return handle;
}
