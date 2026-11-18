// The page's calls to `pi web`: reads are `GET /api/<read>` with ids, dates and codes in the query;
// writes are `POST /api/<write>` with a JSON body and the session's form token in `X-PI-Token`. The
// token comes from `GET /api/session` (`{ token }`) and is kept in this module's memory only (W9). A
// read answers its result as JSON; a write answers `{ result }`; a refusal answers `{ refused: code
// }`. Names and answers are typed by the contract's route table, the one the registry
// (`apps/pi/src/web/web-routes.ts`) serves from.

import type {
  WebPostReadName,
  WebPostReadResult,
  WebReadArgs,
  WebReadName,
  WebReadResult,
  WebWriteName,
} from "@intelligence/contracts/personal";
import { forgetKept, wrote } from "./kept-store.ts";

export type Loaded<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "rebuilding" }
  | { state: "failed"; code: string };
export type Written = { ok: true } | { ok: false; code: string };

// A read answers this refusal while the owner's audience is being rebuilt (a removal emptied it,
// or it was never built), as warmth's `rebuilding` does.
const REBUILDING = "rebuilding";

// What the page does when the session has ended (back to the sign-in screen).
let whenSignedOut: () => void = () => {};
export const onSignedOut = (handler: () => void): void => {
  whenSignedOut = handler;
};

const refusalOf = async (answer: Response): Promise<string> => {
  if (answer.status === 401) {
    token = null;
    // What the ended session read is not shown to the next one.
    forgetKept();
    whenSignedOut();
    return "signed_out";
  }
  try {
    const body = (await answer.json()) as { refused?: unknown };
    if (typeof body.refused === "string") return body.refused;
  } catch {
    // An answer with no JSON body: its status says enough.
  }
  return `http_${answer.status}`;
};

// A GET's answer. `navigate` marks it as the owner's action, which keeps the session alive (the `X-PI-Action` header).
async function got<T>(name: string, args: Readonly<Record<string, string>>, navigate: boolean): Promise<Loaded<T>> {
  const query = new URLSearchParams(args as Record<string, string>).toString();
  try {
    const answer = await fetch(`/api/${name}${query === "" ? "" : `?${query}`}`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: navigate ? { "X-PI-Action": "navigate" } : {},
    });
    if (!answer.ok) {
      const code = await refusalOf(answer);
      return code === REBUILDING ? { state: "rebuilding" } : { state: "failed", code };
    }
    try {
      return { state: "ready", value: (await answer.json()) as T };
    } catch {
      return { state: "failed", code: "bad_answer" };
    }
  } catch {
    return { state: "failed", code: "unreachable" };
  }
}
// Reads asked for while the same one is in flight share its answer, so rows that each want a read
// the page already holds make one request. An owner's own action (`navigate`) is always its own.
const inFlight = new Map<string, Promise<Loaded<unknown>>>();
export const read = <N extends WebReadName>(
  name: N,
  args: WebReadArgs<N> = {},
  navigate = false,
): Promise<Loaded<WebReadResult<N>>> => {
  const plain = args as Readonly<Record<string, string>>;
  if (navigate) return got(name, plain, true);
  const key = `${name}?${new URLSearchParams(plain as Record<string, string>).toString()}`;
  const held = inFlight.get(key);
  if (held !== undefined) return held as Promise<Loaded<WebReadResult<N>>>;
  const asked = got<WebReadResult<N>>(name, plain, false).finally(() => inFlight.delete(key));
  inFlight.set(key, asked);
  return asked;
};
// Whether there is a session, and its form token. Not a route of the registry: the page's way in.
export const readSession = (): Promise<Loaded<{ token?: unknown }>> => got("session", {}, false);

let token: string | null = null;

// The session's form token, or why it could not be had.
async function formToken(): Promise<{ token: string } | { code: string }> {
  if (token !== null) return { token };
  const session = await readSession();
  if (session.state === "failed") return { code: session.code };
  if (session.state !== "ready" || typeof session.value.token !== "string") return { code: "unavailable" };
  token = session.value.token;
  return { token };
}

// A POST with the session's form token: its answer, or why there is none. A token refused is
// forgotten, so the next POST asks for the session's again. `lost`: the request went and no answer
// came, so a write may have happened.
async function posted(
  name: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ answer: Response } | { code: string; lost?: true }> {
  const form = await formToken();
  if ("code" in form) return { code: form.code };
  try {
    const answer = await fetch(`/api/${name}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-PI-Token": form.token, ...headers },
      body: JSON.stringify(body),
    });
    if (answer.ok) return { answer };
    if (answer.status === 403) token = null;
    return { code: await refusalOf(answer) };
  } catch {
    return { code: "unreachable", lost: true };
  }
}

// A request's id, new for each decision (`RequestId`: 8 to 64 of A-Z, a-z, 0-9, _ and -).
const requestId = (): string =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// What a refusal says to the owner, in words; a code not named here is never shown: they read the general words.
const SAID: Record<string, string> = {
  signed_out: "Signed out. Run pia web link in a terminal for a new link.",
  unreachable: "The server did not answer.",
  not_found: "Not found: it may have been answered or removed.",
  not_pending: "Already answered.",
  holders_changed:
    "Someone came to hold that name since this was proposed. Its evidence says how to pick who it is, then answer again.",
  name_held_by_several: "More than one holds that name. Its evidence says how to pick one, then answer again.",
  unavailable: "The server could not answer this.",
  bad_answer: "The server's answer could not be read.",
  not_here: "This is not available on this page yet.",
  already_settled: "Already in force: a ruling of yours settles it.",
  already_ruled: "A ruling of yours is already in force on it.",
  invalid_argument: "That was not accepted. Try again.",
  usage: "That was not accepted. Try again.",
  rebuilding: "Rebuilding. Try again after the next build.",
};
// A code with no words of its own is never shown: the owner gets the general words, the code stays hidden.
const UNKNOWN_REFUSAL = "That could not be loaded. Try again.";
export const said = (code: string): string => SAID[code] ?? UNKNOWN_REFUSAL;

// One owner decision a request, under a new request id.
export async function write(name: WebWriteName, body: Record<string, unknown>): Promise<Written> {
  const sent = await posted(name, { ...body, requestId: requestId() });
  if ("code" in sent) {
    if (sent.code === "unreachable") wrote();
    return { ok: false, code: sent.code };
  }
  wrote();
  return { ok: true };
}

// The same, where the page reads the write's answer (a new task's id, to withdraw it).
export async function post<T>(
  name: WebWriteName,
  body: Record<string, unknown>,
): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  const sent = await posted(name, { ...body, requestId: requestId() });
  if ("code" in sent) {
    if (sent.lost === true) wrote();
    return { ok: false, code: sent.code };
  }
  wrote();
  try {
    return { ok: true, value: (await sent.answer.json()) as T };
  } catch {
    return { ok: false, code: "bad_answer" };
  }
}

// A read whose argument is free text: `POST /api/<read>` with the term in the JSON body and the
// form token, never in a URL, checked by the server as a write is, and changing nothing kept.
// `navigate`: a keystroke, the owner's action.
export async function search<N extends WebPostReadName>(
  name: N,
  term: string,
  navigate = true,
): Promise<Loaded<WebPostReadResult<N>>> {
  const sent = await posted(name, { term }, navigate ? { "X-PI-Action": "navigate" } : {});
  if ("code" in sent) return sent.code === REBUILDING ? { state: "rebuilding" } : { state: "failed", code: sent.code };
  try {
    return { state: "ready", value: (await sent.answer.json()) as WebPostReadResult<N> };
  } catch {
    return { state: "failed", code: "bad_answer" };
  }
}
