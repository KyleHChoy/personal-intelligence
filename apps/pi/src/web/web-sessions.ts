import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { PersonalLogger } from "@intelligence/contracts/personal";

// The dashboard's login codes and sessions (web.ts), in memory and hashed: the link's code and the
// passkey registration's, each 5 minutes and used once, and one session per device.

const MINUTE = 60_000;
export const CODE_MS = 5 * MINUTE;
const LIFETIME_MS = 8 * 60 * MINUTE;
// Idle is measured on the owner's actions, by the kind of login that made the session: a link (the Mac)
// 30 minutes, a passkey (the phone) 10.
const IDLE_MS = { link: 30 * MINUTE, passkey: 10 * MINUTE } as const;
export type Kind = keyof typeof IDLE_MS;
const COOKIE = "pi_session";
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const random = (): string => randomBytes(32).toString("base64url");
const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
export const same = (value: string, hash: Buffer): boolean => timingSafeEqual(sha256(value), hash);

export type Session = { kind: Kind; hash: Buffer; form: Buffer; token: string; started: number; seen: number };
export type CodeKind = "login" | "register";
type Code = { hash: Buffer; until: number };

export type Sessions = ReturnType<typeof createSessions>;

export function createSessions(log: PersonalLogger, now: () => Date) {
  const codes: Record<CodeKind, Code | null> = { login: null, register: null };
  // One session per device, by the kind of login that made it.
  const sessions = new Map<Kind, Session>();

  // A new code of its kind; the last one no longer works.
  const link = (kind: CodeKind = "login"): string => {
    const value = random();
    codes[kind] = { hash: sha256(value), until: now().getTime() + CODE_MS };
    log.info({ event: "web_link", code: kind });
    return value;
  };
  // A code given against the one in force, within its minutes.
  const codeOk = (kind: CodeKind, given: unknown): boolean => {
    const held = codes[kind];
    return (
      held !== null &&
      typeof given === "string" &&
      TOKEN.test(given) &&
      same(given, held.hash) &&
      now().getTime() <= held.until
    );
  };
  const spend = (kind: CodeKind): void => {
    codes[kind] = null;
  };

  // Whether a session is its device's current one and neither idle nor past its lifetime.
  const alive = (session: Session): boolean => {
    const at = now().getTime();
    return (
      sessions.get(session.kind) === session &&
      at - session.seen <= IDLE_MS[session.kind] &&
      at - session.started <= LIFETIME_MS
    );
  };

  // It does not count as the owner's action: only `touch` does.
  const sessionOf = (request: IncomingMessage): Session | null => {
    const value = (request.headers.cookie ?? "")
      .split(";")
      .map((one) => one.trim())
      .find((one) => one.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (value === undefined || !TOKEN.test(value)) return null;
    for (const session of sessions.values()) {
      if (!same(value, session.hash)) continue;
      if (!alive(session)) {
        sessions.delete(session.kind);
        return null;
      }
      return session;
    }
    return null;
  };
  // The owner's action: a page loaded, a write, or a read the client marks as their navigation. Background
  // polling never.
  const touch = (session: Session): void => {
    session.seen = now().getTime();
  };

  // A new session of its kind, ending the last one that kind made: its cookie.
  const open = (kind: Kind, secure: boolean): string => {
    const at = now().getTime();
    const value = random();
    const token = random();
    sessions.set(kind, { kind, hash: sha256(value), form: sha256(token), token, started: at, seen: at });
    log.info({ event: "web_login", code: kind });
    return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`;
  };

  const clear = (): void => {
    sessions.clear();
    codes.login = null;
    codes.register = null;
  };

  return { link, codeOk, spend, alive, sessionOf, touch, open, clear };
}
