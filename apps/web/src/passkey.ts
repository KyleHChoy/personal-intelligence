import type { Written } from "./api.ts";

// The phone's passkey ceremonies: registration with the code `pia web link --register` printed, and
// sign-in. Each asks `pi web` for its options, has the browser make or use the passkey, and posts
// the response; the server answers with the session's cookie. The public key is sent as
// `getPublicKey()` gives it (SPKI), so the server reads no CBOR. Nothing is kept on the device but
// the passkey, in the phone's keychain (W9).

const bytes = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (one) => one.charCodeAt(0));
const text = (data: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// The code, from the link as printed or the code alone.
const CODE = /(?:^|code=)([A-Za-z0-9_-]{43})\s*$/;
export const codeFrom = (given: string): string | null => CODE.exec(given.trim())?.[1] ?? null;

async function post<T>(path: string, body: unknown): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    const answer = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (answer.status === 401) return { ok: false, code: "passkey_refused" };
    if (answer.status === 404) return { ok: false, code: "no_passkey" };
    if (!answer.ok) return { ok: false, code: `http_${answer.status}` };
    return { ok: true, value: (await answer.json()) as T };
  } catch {
    return { ok: false, code: "unreachable" };
  }
}

// The browser's own refusal (the owner cancelled, or the device has no passkey for this page).
const browserRefused = (): Written => ({ ok: false, code: "passkey_cancelled" });

type Creation = {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  authenticatorSelection: AuthenticatorSelectionCriteria;
  attestation: AttestationConveyancePreference;
  timeout: number;
};

export async function registerPasskey(given: string): Promise<Written> {
  const code = codeFrom(given);
  if (code === null) return { ok: false, code: "bad_code" };
  const options = await post<Creation>("/passkey/register-options", { code });
  if (!options.ok) return options.code === "passkey_refused" ? { ok: false, code: "code_refused" } : options;
  const { challenge, user, ...rest } = options.value;
  let made: PublicKeyCredential;
  try {
    const credential = await navigator.credentials.create({
      publicKey: { ...rest, challenge: bytes(challenge), user: { ...user, id: bytes(user.id) } },
    });
    if (credential === null) return browserRefused();
    made = credential as PublicKeyCredential;
  } catch {
    return browserRefused();
  }
  const response = made.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey();
  if (publicKey === null) return { ok: false, code: "no_public_key" };
  const done = await post("/passkey/register", {
    code,
    id: text(made.rawId),
    clientDataJSON: text(response.clientDataJSON),
    authenticatorData: text(response.getAuthenticatorData()),
    publicKey: text(publicKey),
    publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
  });
  return done.ok ? { ok: true } : done;
}

type Request = {
  challenge: string;
  rpId: string;
  allowCredentials: { type: "public-key"; id: string }[];
  userVerification: UserVerificationRequirement;
  timeout: number;
};

export async function signInWithPasskey(): Promise<Written> {
  const options = await post<Request>("/passkey/login-options", {});
  if (!options.ok) return options;
  const { challenge, allowCredentials, ...rest } = options.value;
  let used: PublicKeyCredential;
  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        ...rest,
        challenge: bytes(challenge),
        allowCredentials: allowCredentials.map((one) => ({ ...one, id: bytes(one.id) })),
      },
    });
    if (credential === null) return browserRefused();
    used = credential as PublicKeyCredential;
  } catch {
    return browserRefused();
  }
  const response = used.response as AuthenticatorAssertionResponse;
  const done = await post("/passkey/login", {
    id: text(used.rawId),
    clientDataJSON: text(response.clientDataJSON),
    authenticatorData: text(response.authenticatorData),
    signature: text(response.signature),
  });
  return done.ok ? { ok: true } : done;
}
