import type { IncomingMessage } from "node:http";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import { type Session, same, TOKEN } from "./web-sessions.ts";

// The dashboard's request checks (web.ts): the Host and the Tailscale header before anything is
// read, and the Origin and the session's token before a POST is.

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export type Tailscale = { host: string; login: string };

// With a `ts.net` name set, it is the one Host, and the Tailscale header must name the owner's login; the
// localhost names are the stdio relay's, accepted only without one, and there the header must be absent.
// `tailscale serve` passes a request on with the backend's Host and the name the browser asked for in
// X-Forwarded-Host (checking Host alone answers every request 421). Only pi and pitail open the page's
// socket, so with a ts.net name set the forwarded name is the one checked; the Tailscale header below
// still has to name the owner's login. The Host served, and whether it is the `ts.net` name, or the
// status that refuses the request.
export function hostOf(
  request: IncomingMessage,
  tailscale: Tailscale | undefined,
  log: PersonalLogger,
): { host: string; secure: boolean } | { refused: 421 | 403 } {
  const forwarded = request.headers["x-forwarded-host"];
  const asked = (request.headers.host ?? "").toLowerCase();
  const host = tailscale !== undefined && typeof forwarded === "string" ? forwarded.toLowerCase() : asked;
  const secure = tailscale !== undefined && host === tailscale.host;
  if (tailscale === undefined ? !LOCAL_HOST.test(host) : !secure) {
    log.warn({
      event: "web_host_refused",
      code: typeof forwarded === "string" ? "forwarded" : LOCAL_HOST.test(asked) ? "local" : "other",
    });
    return { refused: 421 };
  }
  if (request.headers["tailscale-user-login"] !== (secure ? tailscale?.login : undefined)) return { refused: 403 };
  return { host, secure };
}

// Whether a POST is not the page's own: a wrong Origin, or no session token.
export function forged(
  request: IncomingMessage,
  session: Session,
  secure: boolean,
  tailscale: Tailscale | undefined,
): boolean {
  const token = request.headers["x-pi-token"];
  return (
    request.headers.origin !==
      (secure && tailscale !== undefined
        ? `https://${tailscale.host}`
        : `http://${(request.headers.host ?? "").toLowerCase()}`) ||
    typeof token !== "string" ||
    !TOKEN.test(token) ||
    !same(token, session.form)
  );
}
