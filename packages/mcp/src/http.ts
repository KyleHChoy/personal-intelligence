import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { PersonalLogger, PersonalToolError } from "@intelligence/contracts/personal";
import { faultOf, SessionTaintCode } from "@intelligence/contracts/personal";
import type { Admission } from "./capture-route.ts";
import { admitCapture, busy, MAX_LARGE_BODIES } from "./capture-route.ts";
import type { Answer, HandleOptions, Request } from "./handle.ts";
import { dispatch } from "./handle.ts";
import type { HttpAnswer } from "./http-answers.ts";
import { bearer, error, json, MAX_BODY, REFUSED } from "./http-answers.ts";
import type { OAuthOptions } from "./oauth.ts";
import { createOAuth } from "./oauth.ts";
import { SessionTaint } from "./session-taint.ts";
import type { Ports } from "./tools.ts";
import { MAX_ADDRESSES, windowAt } from "./windows.ts";

// The agent API over HTTPS, for an agent that cannot start a local command. TLS
// ends at the host's edge. Every route but /healthz is one message handed to `handle`, the one
// dispatcher `pi mcp` serves on stdio: the same token check, tools, views, quotas, deadlines and
// call log. Nothing here reads a store.
//
//   POST /mcp              MCP Streamable HTTP: one JSON-RPC message in, its reply out. An
//                          initialize answers an Mcp-Session-Id, and a request that sends it back
//                          is that session's (session-taint.ts); nothing else is kept per session.
//   GET  /v1/tools         the client's tools, as tools/list gives them.
//   POST /v1/tools/<name>  the tool's arguments in, its value out.
//   GET  /openapi.json     the REST routes of the client's tools, built from tools/list.
//   GET  /healthz          ok, and nothing else; 503 schema_behind while the database's
//                          migrations are behind this image's (`schemaCurrent`).
//
// With `oauth` (PI_HTTP_BASE_URL set), the OAuth routes of oauth.ts too, and a failed token check
// on the routes above answers 401 with the challenge that points at the discovery document
//.

// Failed token checks one address may make in a window before it is refused outright.
export const MAX_FAILURES = 20;
const WINDOW_MS = 60_000;

export type HttpOptions = HandleOptions & {
  // True while the owner's read hold is set: everything but /healthz answers unavailable.
  held?: () => boolean;
  // False while the database has not applied every migration this image holds, or while that is
  // not known: /healthz answers 503, so the host's health check refuses a deploy that could not
  // migrate. Unset, /healthz always answers ok.
  schemaCurrent?: () => boolean;
  // The wall clock of the failed-auth window.
  now?: () => number;
  // OAuth for the agent endpoint; without it, none of its routes exist and a failed token check
  // answers 403.
  oauth?: OAuthOptions;
  // True only when a proxy the owner configured stands in front and adds the caller's address as
  // the last X-Forwarded-For entry (PI_HTTP_TRUST_PROXY). Otherwise the header is the caller's own
  // words, and every per-address limit keys on the socket's address.
  trustForwarded?: boolean;
};

export type HttpRequest = {
  method: string;
  path: string;
  // The query string, without its `?`.
  query?: string;
  authorization?: string | undefined;
  address: string;
  body: string;
  host?: string | undefined;
  origin?: string | undefined;
  // The Mcp-Session-Id header the client sent back, if any.
  session?: string | undefined;
};
// An Mcp-Session-Id as MCP allows one: visible ASCII. Any other is taken as none, so the request is
// its token's session.
const SESSION_ID = /^[\x21-\x7e]{1,128}$/;
const sessionOf = (header: string | undefined): string | undefined =>
  header !== undefined && SESSION_ID.test(header) ? header : undefined;
const isInitialize = (body: string): boolean => {
  try {
    return (JSON.parse(body) as { method?: unknown } | null)?.method === "initialize";
  } catch {
    return false;
  }
};
// How REST answers each code a tool can answer. `details`: the refusal's arguments and hint ride
// along as fields of the answer. A code with no row does not compile.
const REST_ANSWERS: Readonly<Record<PersonalToolError, { status: number; error: string; details?: true }>> = {
  unauthorized: { status: 403, error: "not_permitted" },
  not_permitted: { status: 403, error: "not_permitted", details: true },
  invalid_request: { status: 400, error: "invalid_request", details: true },
  not_found: { status: 404, error: "not_found", details: true },
  rate_limited: { status: 429, error: "rate_limited", details: true },
  // propose_task's and hand_off's role no active agent holds, with its hint.
  unknown_role: { status: 422, error: "unknown_role", details: true },
  // sync_mirror's own two: a stale cursor, which Lens wipes on, and
  // no template version the server knows.
  stale_cursor: { status: 409, error: "stale_cursor", details: true },
  unsupported_template: { status: 406, error: "unsupported_template", details: true },
  unavailable: { status: 503, error: "unavailable" },
};

// A tools/call or tools/list answer as a REST answer. A code that is no tool's, a fault among them,
// is unavailable.
function rest(answered: Answer, value: (result: Record<string, unknown>) => unknown): HttpAnswer {
  if (answered.code === "unauthorized" || answered.code === "not_permitted") return REFUSED;
  if (answered.code === "ok") return json(200, value((answered.reply as { result: Record<string, unknown> }).result));
  // A call refused for its session's label, with its hint.
  if (SessionTaintCode.safeParse(answered.code).success)
    return json(403, { error: answered.code, ...answered.details });
  if (!Object.hasOwn(REST_ANSWERS, answered.code)) return error(503, "unavailable");
  const { status, error: code, details } = REST_ANSWERS[answered.code as PersonalToolError];
  return json(status, { error: code, ...(details === true ? answered.details : {}) });
}

type Listed = { name: string; description: string; inputSchema: unknown };

function openapi(tools: Listed[]): unknown {
  const ok = { description: "The tool's value.", content: { "application/json": { schema: { type: "object" } } } };
  const refused = {
    description: "A refusal: { error: code }.",
    content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
  };
  return {
    openapi: "3.1.0",
    info: { title: "Personal Intelligence", version: "0" },
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    security: [{ bearer: [] }],
    paths: Object.fromEntries(
      tools.map((tool) => [
        `/v1/tools/${tool.name}`,
        {
          post: {
            operationId: tool.name,
            description: tool.description,
            requestBody: { required: true, content: { "application/json": { schema: tool.inputSchema } } },
            responses: {
              "200": ok,
              "400": refused,
              "403": refused,
              "404": refused,
              ...(tool.name === "sync_mirror" ? { "406": refused, "409": refused } : {}),
              "422": refused,
              "429": refused,
              "503": refused,
            },
          },
        },
      ]),
    ),
  };
}

// The routes, over a request already read whole. Exported for tests; `serveHttp` is the server.
export function createRoutes(
  ports: Ports,
  log: PersonalLogger,
  options: HttpOptions = {},
): (request: HttpRequest) => Promise<HttpAnswer> {
  const { answer } = makeRoutes(ports, log, options);
  return (request) => answer({ ...request, address: addressKey(request.address) }, false);
}

// `counted`: the request is in its address's pending already, since before its body was read. A
// request's address is already its key (addressKey).
export function makeRoutes(
  ports: Ports,
  log: PersonalLogger,
  options: HttpOptions,
): { answer(request: HttpRequest, counted: boolean): Promise<HttpAnswer>; admission: Admission } {
  const { held, schemaCurrent, now = Date.now, oauth: oauthOptions, ...given } = options;
  // The sessions' labels of this server's routes.
  const timing = { ...given, taint: given.taint ?? new SessionTaint(now) };
  const oauth = oauthOptions === undefined ? undefined : createOAuth({ now, ...oauthOptions }, log);
  // One answer for a token missing, unknown, expired or revoked.
  const unauthorized: HttpAnswer | undefined =
    oauth === undefined
      ? undefined
      : { ...error(401, "unauthorized"), headers: { "www-authenticate": oauth.challenge } };
  // Per address: failed token checks in the current window, and requests still being answered,
  // which count against the limit until they end, so a burst sent at once cannot pass it.
  const failures = new Map<string, { count: number; since: number }>();
  const pending = new Map<string, number>();
  const refuse = (answer: HttpAnswer, code: string): HttpAnswer => {
    log.warn({ event: "http_refused", code, status: `http_${answer.status}` });
    return answer;
  };
  const failed = (address: string, at: number): number => windowAt(failures.get(address), at, WINDOW_MS).count;
  // A full table loses the one row with the fewest failed checks, never all of them: a caller with
  // many addresses could otherwise clear its own limit. One failed check is as few as a live row holds.
  const dropFewest = (at: number): void => {
    let fewest: { address: string; count: number } | undefined;
    for (const address of failures.keys()) {
      const count = failed(address, at);
      if (fewest === undefined || count < fewest.count) fewest = { address, count };
      if (fewest.count <= 1) break;
    }
    if (fewest !== undefined) failures.delete(fewest.address);
  };
  const fail = (address: string): void => {
    if (failures.size >= MAX_ADDRESSES && !failures.has(address)) dropFewest(now());
    const window = windowAt(failures.get(address), now(), WINDOW_MS);
    failures.set(address, { count: window.count + 1, since: window.since });
  };
  const enter = (address: string): void => {
    // Full: a new address goes uncounted, and the counts already held stay.
    if (pending.size >= MAX_ADDRESSES && !pending.has(address)) return;
    pending.set(address, (pending.get(address) ?? 0) + 1);
  };
  const leave = (address: string): void => {
    const left = (pending.get(address) ?? 1) - 1;
    if (left > 0) pending.set(address, left);
    else pending.delete(address);
  };
  // Failed checks and the requests in flight but this one, against the limit.
  const throttledAt = (address: string, counted: boolean): boolean =>
    failed(address, now()) + (pending.get(address) ?? 0) - (counted ? 1 : 0) >= MAX_FAILURES;
  const admission: Admission = {
    enter,
    leave,
    throttled: (address) => throttledAt(address, true),
    failed: fail,
    unauthorized: unauthorized ?? REFUSED,
  };

  const answer = async (
    { method, path, query = "", authorization, address, body, host, origin, session: sent }: HttpRequest,
    counted: boolean,
  ): Promise<HttpAnswer> => {
    if (path === "/healthz") {
      if (method !== "GET") return refuse(error(405, "method_not_allowed"), "method_not_allowed");
      return schemaCurrent?.() === false
        ? error(503, "schema_behind")
        : { status: 200, body: "ok", type: "text/plain" };
    }
    if (oauth?.handles(path) === true) {
      if (held?.()) return refuse(error(503, "unavailable"), "read_hold");
      return oauth.route({ method, path, query, address, body, host, origin });
    }

    const route =
      path === "/mcp"
        ? "mcp"
        : path === "/v1/tools"
          ? "list"
          : path === "/openapi.json"
            ? "openapi"
            : path.startsWith("/v1/tools/")
              ? "call"
              : undefined;
    if (route === undefined) return refuse(error(404, "not_found"), "not_found");
    const wanted = route === "mcp" || route === "call" ? "POST" : "GET";
    if (method !== wanted) return refuse(error(405, "method_not_allowed"), "method_not_allowed");
    if (held?.()) return refuse(error(503, "unavailable"), "read_hold");

    if (throttledAt(address, counted)) return refuse(error(429, "rate_limited"), "auth_throttled");

    const token = bearer(authorization);
    let message: string | Request;
    if (route === "mcp") message = body;
    else if (route === "call") {
      let args: unknown;
      try {
        args = body.trim() === "" ? {} : JSON.parse(body);
      } catch {
        return refuse(error(400, "invalid_request"), "parse_error");
      }
      let name: string;
      try {
        name = decodeURIComponent(path.slice("/v1/tools/".length));
      } catch {
        return refuse(REFUSED, "not_permitted");
      }
      message = { kind: "request", id: 1, method: "tools/call", params: { name, arguments: args } };
    } else message = { kind: "request", id: 1, method: "tools/list", params: {} };

    if (!counted) enter(address);
    let answered: Answer | null;
    try {
      const session = route === "mcp" ? sessionOf(sent) : undefined;
      answered = await dispatch(ports, log, token, message, {
        ...timing,
        ...(session === undefined ? {} : { session }),
      });
    } finally {
      if (!counted) leave(address);
    }
    if (answered?.code === "unauthorized") {
      fail(address);
      if (unauthorized !== undefined) return refuse(unauthorized, "unauthorized");
    }

    if (answered === null) return { status: 202, body: "", type: "application/json" };
    if (route === "mcp") {
      // An initialize that names no session starts one: its id rides on the answer.
      const opened = answered.code === "ok" && sessionOf(sent) === undefined && isInitialize(body);
      return opened
        ? { ...json(200, answered.reply), headers: { "mcp-session-id": randomUUID() } }
        : json(200, answered.reply);
    }
    if (route === "call") return rest(answered, (result) => result.structuredContent);
    const listed = (result: Record<string, unknown>) => result.tools as Listed[];
    return route === "list"
      ? rest(answered, (result) => ({ tools: listed(result) }))
      : rest(answered, (result) => openapi(listed(result)));
  };
  return { answer, admission };
}

const headerOf = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

// The caller's address: with a trusted proxy, the last X-Forwarded-For entry, which that proxy
// adds; else, and always without one, the socket's. Keyed as every limit keys it (addressKey).
function addressOf(request: IncomingMessage, trustForwarded: boolean): string {
  if (!trustForwarded) return addressKey(request.socket.remoteAddress || "unknown");
  const forwarded = request.headers["x-forwarded-for"];
  const last = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")).split(",").pop()?.trim();
  return addressKey(last || request.socket.remoteAddress || "unknown");
}

// What a per-address limit keys on. An IPv6 address is its /64, the block one host is usually
// given, so a caller cannot step out of a limit by moving through its own block; an IPv4 address
// written in IPv6 (`::ffff:a.b.c.d`) is the IPv4 address. Anything else, IPv4 included, is itself.
export function addressKey(address: string): string {
  if (!address.includes(":") || address.includes("/")) return address;
  const bare = address.replace(/%.*$/, "").toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped !== null) return mapped[1] as string;
  const halves = bare.split("::");
  if (halves.length > 2) return address;
  const words = (half: string | undefined): string[] => (half === undefined || half === "" ? [] : half.split(":"));
  const head = words(halves[0]);
  const tail = words(halves[1]);
  // A last word in dotted form is two words.
  const last = tail.length > 0 ? tail : head;
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(last[last.length - 1] ?? "");
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    last.splice(last.length - 1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return address;
  const all = [...head, ...Array.from({ length: halves.length === 1 ? 0 : missing }, () => "0"), ...tail];
  if (!all.every((word) => /^[0-9a-f]{1,4}$/.test(word))) return address;
  return `${all
    .slice(0, 4)
    .map((word) => Number.parseInt(word, 16).toString(16))
    .join(":")}::/64`;
}

// The body, whole, or null past the cap. Past it the rest is read and dropped, so the 413 is
// delivered; the request timeout bounds how long that takes. A request whose connection closed
// before its end rejects, so the caller's counts are released.
function readBody(
  request: IncomingMessage,
  cap = MAX_BODY,
  large: () => boolean = () => false,
): Promise<string | null | "busy"> {
  return new Promise((resolve, reject) => {
    if (request.destroyed || request.readableAborted) return reject(new Error("closed"));
    const parts: Buffer[] = [];
    let size = 0;
    let dropped = false;
    const drop = (answer: null | "busy"): void => {
      dropped = true;
      parts.length = 0;
      resolve(answer);
    };
    request.on("data", (chunk: Buffer) => {
      if (dropped) return;
      const before = size;
      size += chunk.length;
      if (size > cap) return drop(null);
      if (before <= MAX_BODY && size > MAX_BODY && !large()) return drop("busy");
      parts.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    request.on("error", reject);
    request.on("close", () => {
      if (!request.complete) reject(new Error("closed"));
    });
  });
}

export function serveHttp(ports: Ports, log: PersonalLogger, options: HttpOptions = {}): Server {
  const { answer: routes, admission } = makeRoutes(ports, log, options);
  // The bodies over MAX_BODY being read or answered, across the server.
  let large = 0;
  const tooLarge = (): HttpAnswer => {
    log.warn({ event: "http_refused", code: "body_too_large", status: "http_413" });
    return error(413, "invalid_request");
  };
  const send = (response: ServerResponse, answer: HttpAnswer): void => {
    response.writeHead(answer.status, {
      "content-type": answer.type === "text/html" ? "text/html; charset=utf-8" : answer.type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...answer.headers,
    });
    response.end(answer.body);
  };
  const server = createServer((request, response) => {
    const address = addressOf(request, options.trustForwarded === true);
    let holds = false;
    const hold = (): boolean => {
      if (holds) return true;
      if (large >= MAX_LARGE_BODIES) return false;
      large += 1;
      holds = true;
      return true;
    };
    // Counted in its address's pending before its body is read, until it is answered.
    admission.enter(address);
    void (async () => {
      const [path = "/", query = ""] = (request.url ?? "/").split(/\?(.*)/s);
      const declared = Number(request.headers["content-length"] ?? 0);
      // The cap is chosen by route before the body is read.
      const admitted = await admitCapture(request, {
        path,
        address,
        declared,
        held: options.held,
        provider: ports.provider,
        log,
        admission,
        hold,
      });
      if (admitted === "gone") return;
      if ("answer" in admitted) return closing(response, admitted.answer);
      const { cap, unknown } = admitted;
      const body = declared > cap ? null : await readBody(request, cap, hold);
      if (body === null || body === "busy") {
        if (unknown) admission.failed(address);
        return closing(response, body === null ? tooLarge() : busy(log));
      }
      send(
        response,
        await routes(
          {
            method: request.method ?? "",
            path,
            query,
            authorization: request.headers.authorization,
            address,
            body,
            host: request.headers.host,
            origin: request.headers.origin,
            session: headerOf(request.headers["mcp-session-id"]),
          },
          true,
        ),
      );
    })()
      .catch((thrown: unknown) => {
        // The client's check or the body's read failed: an expected fault by its SQLSTATE or
        // class, a bug by its class, never its message. Either is answered 503.
        const fault = faultOf(thrown);
        const line = {
          event: "http_refused",
          code: fault.expected ? "unavailable" : "bug",
          ...(fault.reason === undefined ? {} : { reason: fault.reason }),
          status: "http_503",
        } as const;
        if (fault.expected) log.warn(line);
        else log.error(line);
        if (!response.headersSent) send(response, error(503, "unavailable"));
        else response.destroy();
      })
      .finally(() => {
        admission.leave(address);
        if (holds) large -= 1;
      });
  });
  // An answer sent before the body is read whole: the connection closes after it.
  const closing = (response: ServerResponse, answer: HttpAnswer): void => {
    response.setHeader("connection", "close");
    send(response, answer);
  };
  // A request is read whole within these, or its socket is closed.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}
