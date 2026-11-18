import type { IncomingMessage } from "node:http";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import { ClientView } from "@intelligence/contracts/personal";
import type { HttpAnswer } from "./http-answers.ts";
import { bearer, error, MAX_BODY, REFUSED } from "./http-answers.ts";
import type { Provider } from "./tools.ts";

// Lens's push route alone: POST /v1/tools/push_capture takes up to 1 MiB,
// read past MAX_BODY only for a client whose tools are exactly push_capture, and at most
// MAX_LARGE_BODIES such bodies are read at once across the server.
export const CAPTURE_ROUTE = "/v1/tools/push_capture";
export const MAX_CAPTURE_BODY = 1024 * 1024;
export const MAX_LARGE_BODIES = 4;

export type Admission = {
  enter(address: string): void;
  leave(address: string): void;
  throttled(address: string): boolean;
  failed(address: string): void;
  // The answer to a token that is no client's, as the routes give it.
  unauthorized: HttpAnswer;
};

// A client whose tools are exactly push_capture, which a registration of kind
// device must be and no other kind can be (ClientRegistration). ClientView has no kind.
const isDevice = (found: unknown): boolean => {
  const view = ClientView.safeParse(found);
  return view.success && view.data.tools.length === 1 && view.data.tools[0] === "push_capture";
};

export const busy = (log: PersonalLogger): HttpAnswer => {
  log.warn({ event: "http_refused", code: "large_bodies_busy", status: "http_429" });
  return error(429, "rate_limited");
};

type CaptureContext = {
  path: string;
  address: string;
  declared: number;
  held: (() => boolean) | undefined;
  provider: Provider;
  log: PersonalLogger;
  admission: Admission;
  // Takes a place among the large bodies being read: false when none is free.
  hold: () => boolean;
};

// The cap of a request's body, before it is read: `unknown`, a token that is no client's, refused
// here before its body and counted as a failed check, as `handle` counts one it is handed; `answer`,
// a refusal sent before the body is read; "gone", the caller left while its token was checked. Past
// MAX_BODY the push route reads on only for a device's capture client, shown by one client(token)
// call, and only while fewer than MAX_LARGE_BODIES such bodies are in hand.
export async function admitCapture(
  request: IncomingMessage,
  { path, address, declared, held, provider, log, admission, hold }: CaptureContext,
): Promise<{ cap: number; unknown: boolean } | { answer: HttpAnswer } | "gone"> {
  let cap = MAX_BODY;
  let unknown = false;
  if (request.method !== "POST" || path !== CAPTURE_ROUTE) return { cap, unknown };
  // The read hold answers 503 to the push route before its body is read, whatever its size.
  if (held?.()) {
    log.warn({ event: "http_refused", code: "read_hold", status: "http_503" });
    return { answer: error(503, "unavailable") };
  }
  const noLength = request.headers["content-length"] === undefined;
  if ((declared > MAX_BODY || noLength) && declared <= MAX_CAPTURE_BODY) {
    if (admission.throttled(address)) {
      log.warn({ event: "http_refused", code: "auth_throttled", status: "http_429" });
      return { answer: error(429, "rate_limited") };
    }
    const token = bearer(request.headers.authorization);
    const found = token === undefined ? null : await provider.client(token);
    if (request.destroyed) return "gone";
    unknown = found === null;
    if (isDevice(found)) {
      if (declared > MAX_BODY && !hold()) return { answer: busy(log) };
      cap = MAX_CAPTURE_BODY;
    } else if (noLength) {
      // A body of no declared length from any other caller is refused before it is read: it
      // could pass 64 KiB before it ends.
      if (unknown) admission.failed(address);
      log.warn({
        event: "http_refused",
        code: unknown ? "unauthorized" : "not_permitted",
        status: `http_${unknown ? admission.unauthorized.status : 403}`,
      });
      return { answer: unknown ? admission.unauthorized : REFUSED };
    }
  }
  return { cap, unknown };
}
