import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type PersonalLogger, RestrictedUnlockPost } from "@intelligence/contracts/personal";
import { codeOf } from "../env.ts";
import { answer, json, readJson } from "./web-answer.ts";
import { ES256, loadPasskey, type Passkey, savePasskey, verifyAssertion, verifyRegistration } from "./web-passkey.ts";
import { lockState, type RestrictedLock, unlockWith, wrappedOf } from "./web-restricted.ts";
import { CODE_MS, type Sessions } from "./web-sessions.ts";

// The passkey's ceremonies (web.ts), on the `ts.net` name only, each step a POST: registration with
// the code `pi web link --register` printed, and assertion, each after its options. Within a
// session, the restricted keys' unlock by a fresh assertion, its state and the lock.
export const CEREMONY = {
  "/passkey/register-options": "register-options",
  "/passkey/register": "register",
  "/passkey/login-options": "login-options",
  "/passkey/login": "login",
  "/restricted/unlock-options": "unlock-options",
  "/restricted/unlock": "unlock",
  "/restricted/status": "restricted-status",
  "/restricted/lock": "restricted-lock",
} as const;
export type Step = (typeof CEREMONY)[keyof typeof CEREMONY];
// The passkey's account on the phone: one owner, the same id at each registration, so a new one
// replaces the last in the owner's keychain. No name of the owner's: the page's own.
const PASSKEY_USER = {
  id: Buffer.from("pi-owner").toString("base64url"),
  name: "owner",
  displayName: "Personal Intelligence",
};

// The phone's passkey, read from `passkeyPath` beside the key file (web-passkey.ts). A file that is
// not one leaves the phone with no passkey, logged by its code, and the Mac's link still works.
// `restricted`: the wrapped restricted key file and the unlock this process holds, when one is set.
export async function createCeremonies(
  passkeyPath: string,
  sessions: Sessions,
  log: PersonalLogger,
  now: () => Date,
  restricted?: RestrictedLock,
) {
  let passkey: Passkey | null = await loadPasskey(passkeyPath).catch((error: unknown) => {
    log.error({ event: "web_passkey_unread", code: codeOf(error) });
    return null;
  });
  // Writes of the passkey's file, one after another, each of the passkey as it is then.
  let saving: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    saving = saving.catch(() => {}).then(() => (passkey === null ? undefined : savePasskey(passkeyPath, passkey)));
    return saving;
  };
  // The challenge of each ceremony in flight: one at a time, 5 minutes, used once.
  type Kind = "register" | "login" | "unlock";
  const challenges = new Map<Kind, { value: Buffer; until: number }>();

  const challenge = (kind: Kind): string => {
    const value = randomBytes(32);
    challenges.set(kind, { value, until: now().getTime() + CODE_MS });
    return value.toString("base64url");
  };
  // The ceremony's challenge, used once whatever the outcome.
  const takeChallenge = (kind: Kind): Buffer | null => {
    const held = challenges.get(kind);
    challenges.delete(kind);
    return held === undefined || now().getTime() > held.until ? null : held.value;
  };
  const signedIn = (response: ServerResponse): void =>
    answer(response, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8", {
      "Set-Cookie": sessions.open("passkey", true),
    });

  // Each ceremony's step, without a session: a POST of JSON from the page's own https origin. A
  // refusal is 401 with an empty body, its code in the log.
  const ceremony = async (
    request: IncomingMessage,
    response: ServerResponse,
    step: Step,
    host: string,
  ): Promise<void> => {
    if (request.headers.origin !== `https://${host}`) {
      request.resume();
      return answer(response, 403);
    }
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return json(response, 400, { refused: "usage" });
    const given = body as Record<string, unknown>;
    const refuse = (code: string): void => {
      log.warn({ event: "web_refused", code });
      answer(response, 401);
    };
    if (step === "register-options") {
      if (!sessions.codeOk("register", given.code)) return refuse("passkey_code");
      return json(response, 200, {
        challenge: challenge("register"),
        rp: { id: host, name: "Personal Intelligence" },
        user: PASSKEY_USER,
        pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        attestation: "none",
        timeout: CODE_MS,
      });
    }
    if (step === "register") {
      const value = takeChallenge("register");
      if (value === null || !sessions.codeOk("register", given.code)) return refuse("passkey_code");
      const made = verifyRegistration(given, { host, challenge: value });
      if (made === null) return refuse("passkey_refused");
      // The new passkey replaces the last at once: a sign-in begun with the last one fails, and
      // the session it opened ends with this one's.
      sessions.spend("register");
      challenges.delete("login");
      challenges.delete("unlock");
      passkey = made;
      await persist();
      log.info({ event: "web_passkey_registered" });
      return signedIn(response);
    }
    if (passkey === null) return json(response, 404, { refused: "no_passkey" });
    if (step === "login-options") {
      return json(response, 200, {
        challenge: challenge("login"),
        rpId: host,
        allowCredentials: [{ type: "public-key", id: passkey.id }],
        userVerification: "required",
        timeout: CODE_MS,
      });
    }
    // The passkey's assertion over the challenge of `kind`, its new sign count kept: whether it holds.
    const asserted = async (kind: "login" | "unlock"): Promise<boolean> => {
      const value = takeChallenge(kind);
      const signCount =
        value === null || passkey === null ? null : verifyAssertion(given, { host, challenge: value }, passkey);
      if (signCount === null || passkey === null) return false;
      if (signCount !== passkey.signCount) {
        passkey = { ...passkey, signCount };
        await persist();
      }
      return true;
    };
    if (step === "login") return (await asserted("login")) ? signedIn(response) : refuse("passkey_refused");
    // The restricted keys' unlock (web-restricted.ts): within a session, by a fresh assertion.
    if (sessions.sessionOf(request) === null) return refuse("no_session");
    if (step === "restricted-status") return json(response, 200, await lockState(restricted));
    if (step === "restricted-lock") {
      restricted?.unlock.lock();
      log.info({ event: "restricted_locked_by_owner" });
      return json(response, 200, await lockState(restricted));
    }
    const file = await wrappedOf(restricted);
    if (file === undefined) return json(response, 404, { refused: "no_restricted_lock" });
    if (step === "unlock-options") {
      return json(response, 200, {
        challenge: challenge("unlock"),
        rpId: host,
        allowCredentials: [{ type: "public-key", id: passkey.id }],
        userVerification: "required",
        timeout: CODE_MS,
        prfSalt: file.prfSalt,
      });
    }
    const post = RestrictedUnlockPost.safeParse(given);
    if (!post.success) {
      takeChallenge("unlock");
      return json(response, 400, { refused: "usage" });
    }
    if (!(await asserted("unlock"))) return refuse("passkey_refused");
    const until = await unlockWith(restricted, passkey.id, post.data);
    if (!(until instanceof Date)) return refuse(until);
    log.info({ event: "restricted_unlocked" });
    json(response, 200, { state: "unlocked", until: until.toISOString() });
  };

  return { ceremony, clear: () => challenges.clear() };
}
