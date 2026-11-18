import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { ClientFile } from "./web-client.ts";

// How the dashboard's server answers (web.ts): every answer with the security headers, the client's
// files in the encoding the browser accepts, a long JSON answer compressed, and a request's JSON body
// within its limit.

// `Referrer-Policy` is `same-origin`, not `no-referrer`: under `no-referrer` a browser sends `Origin: null`
// with a POST, which the Origin check must refuse, so no decision could be made. No page links outside the
// box.
export const WEB_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'",
  "Cache-Control": "no-store",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
} as const;

// A file under /assets/ is named by a hash of its content and holds code, styles or a typeface,
// never data, so the browser may keep it a year without asking again; a new build names new files.
// Everything else keeps `no-store`.
const KEPT = "public, max-age=31536000, immutable";
// A read's answer longer than this is compressed for a browser that accepts it; shorter ones gain
// too little to be worth the work.
const COMPRESS_BYTES = 1024;
const BODY_BYTES = 16_384;
const JSON_TYPE = "application/json; charset=utf-8";
const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

// Of the two encodings the server sends, the one a request's Accept-Encoding weighs higher, brotli
// on a tie, or neither. A coding with q=0 is refused; `*` stands for any not named.
export function encodingFor(header: string | string[] | undefined): "br" | "gzip" | null {
  const weights = new Map<string, number>();
  for (const part of (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",")) {
    const [name = "", ...params] = part.split(";").map((one) => one.trim().toLowerCase());
    const q = params.find((one) => one.startsWith("q="));
    if (name !== "") weights.set(name, q === undefined ? 1 : Number(q.slice(2)) || 0);
  }
  const weight = (name: string): number => weights.get(name) ?? weights.get("*") ?? 0;
  const [br, gz] = [weight("br"), weight("gzip")];
  return br > 0 && br >= gz ? "br" : gz > 0 ? "gzip" : null;
}

export function answer(
  response: ServerResponse,
  status: number,
  body: Buffer | string = "",
  type?: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { ...WEB_HEADERS, ...(type === undefined ? {} : { "Content-Type": type }), ...headers });
  response.end(body);
}

export const json = (response: ServerResponse, status: number, value: unknown): void =>
  answer(response, status, JSON.stringify(value), JSON_TYPE);

// One of the client's files, in the best encoding the build made of it that the browser accepts;
// `kept` for a content-named file under /assets/, never for the shell.
export function file(request: IncomingMessage, response: ServerResponse, one: ClientFile, kept: boolean): void {
  const encoding = encodingFor(request.headers["accept-encoding"]);
  const packed = encoding === null || one[encoding] === undefined ? null : { encoding, body: one[encoding] };
  answer(response, 200, packed?.body ?? one.body, one.type, {
    ...(one.br === undefined && one.gzip === undefined ? {} : { Vary: "Accept-Encoding" }),
    ...(packed === null ? {} : { "Content-Encoding": packed.encoding }),
    ...(kept ? { "Cache-Control": KEPT } : {}),
  });
}

// A read's JSON text, compressed when it is long and the browser accepts it. Only reads are: the
// session's form token and the passkey's challenges go uncompressed, so no secret shares a
// compressed answer.
export async function packed(request: IncomingMessage, response: ServerResponse, text: string): Promise<void> {
  const encoding = Buffer.byteLength(text) > COMPRESS_BYTES ? encodingFor(request.headers["accept-encoding"]) : null;
  if (encoding === null) return answer(response, 200, text, JSON_TYPE, { Vary: "Accept-Encoding" });
  // Brotli at a middle quality: near its best size for JSON, at a few milliseconds a read.
  const body =
    encoding === "br" ? await brotli(text, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) : await gzipped(text);
  answer(response, 200, body, JSON_TYPE, { Vary: "Accept-Encoding", "Content-Encoding": encoding });
}

// A JSON body within the limit, or undefined. One over the limit is read to its end and dropped, so
// its refusal still reaches the browser.
export const readJson = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    if ((request.headers["content-type"] ?? "").split(";")[0]?.trim() !== "application/json") {
      request.resume();
      return resolve(undefined);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_BYTES) chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > BODY_BYTES) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    request.on("error", () => resolve(undefined));
  });
