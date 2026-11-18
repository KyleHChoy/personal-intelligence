import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isCoded } from "@intelligence/contracts/personal";
import { refusal } from "../env.ts";

// The phone's passkey: what `pi web` checks of a WebAuthn registration and assertion, with
// node:crypto alone and no CBOR parser. The browser hands over the credential's public key itself
// (`response.getPublicKey()`, SPKI DER), so the attestation object is never read; attestation is
// `none`, and what makes a registration the owner's is the one-use code from a terminal.
//
// The one credential lives in `<PI_KEY_FILE>.web-passkey`, beside the key file, pi's alone (0600):
// a server restart must not cost the owner their passkey. It holds the
// credential's id, its public key and its last sign count, nothing secret. A new registration
// replaces it.

export type Passkey = { id: string; publicKey: string; signCount: number };
// What the server issued for one ceremony: its random challenge, at the page's `ts.net` name.
export type Ceremony = { host: string; challenge: Buffer };

// ES256, the one algorithm offered (COSE -7).
export const ES256 = -7;
const B64URL = /^[A-Za-z0-9_-]{1,4096}$/;
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

const sha256 = (data: Buffer | string): Buffer => createHash("sha256").update(data).digest();
const bytes = (value: unknown): Buffer | null =>
  typeof value === "string" && B64URL.test(value) ? Buffer.from(value, "base64url") : null;

// The client data: of the ceremony's type, naming the server's challenge and the https origin of
// the `ts.net` name, never from a frame of another origin.
function clientDataOk(raw: Buffer, type: string, ceremony: Ceremony): boolean {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    data = JSON.parse(raw.toString("utf8")) as typeof data;
  } catch {
    return false;
  }
  return (
    data.type === type &&
    data.challenge === ceremony.challenge.toString("base64url") &&
    data.origin === `https://${ceremony.host}` &&
    data.crossOrigin !== true
  );
}

// The authenticator data: for the `ts.net` name, the user present and verified. Its sign count, or
// null.
function authenticatorOk(data: Buffer, ceremony: Ceremony): number | null {
  if (data.length < 37 || !data.subarray(0, 32).equals(sha256(ceremony.host))) return null;
  const flags = data[32] ?? 0;
  if ((flags & UP) === 0 || (flags & UV) === 0) return null;
  return data.readUInt32BE(33);
}

// A registration the client posts, checked against the ceremony: the new passkey, or null.
export function verifyRegistration(body: unknown, ceremony: Ceremony): Passkey | null {
  const given = (body ?? {}) as Record<string, unknown>;
  const id = bytes(given.id);
  const clientData = bytes(given.clientDataJSON);
  const authenticator = bytes(given.authenticatorData);
  const spki = bytes(given.publicKey);
  if (
    id === null ||
    clientData === null ||
    authenticator === null ||
    spki === null ||
    given.publicKeyAlgorithm !== ES256
  )
    return null;
  if (!clientDataOk(clientData, "webauthn.create", ceremony)) return null;
  const signCount = authenticatorOk(authenticator, ceremony);
  // The attested credential data follows the 37 bytes: an AAGUID (16), the id's length (2) and the
  // id, which must be the one posted.
  if (signCount === null || ((authenticator[32] ?? 0) & AT) === 0 || authenticator.length < 55) return null;
  const length = authenticator.readUInt16BE(53);
  if (!authenticator.subarray(55, 55 + length).equals(id) || length !== id.length) return null;
  let publicKey: string;
  try {
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    publicKey = key.export({ format: "der", type: "spki" }).toString("base64url");
  } catch {
    return null;
  }
  return { id: id.toString("base64url"), publicKey, signCount };
}

// An assertion the client posts, checked against the ceremony and the stored passkey: its new sign
// count, or null. The signature is ES256 over the authenticator data and the client data's hash.
// The count must rise; a passkey that keeps no count (iCloud Keychain's report 0 every time) stays
// at 0, which is not a fall.
export function verifyAssertion(body: unknown, ceremony: Ceremony, passkey: Passkey): number | null {
  const given = (body ?? {}) as Record<string, unknown>;
  const clientData = bytes(given.clientDataJSON);
  const authenticator = bytes(given.authenticatorData);
  const signature = bytes(given.signature);
  if (given.id !== passkey.id || clientData === null || authenticator === null || signature === null) return null;
  if (!clientDataOk(clientData, "webauthn.get", ceremony)) return null;
  const signCount = authenticatorOk(authenticator, ceremony);
  if (signCount === null || !(signCount > passkey.signCount || (signCount === 0 && passkey.signCount === 0)))
    return null;
  try {
    const key = createPublicKey({ key: Buffer.from(passkey.publicKey, "base64url"), format: "der", type: "spki" });
    return verify("sha256", Buffer.concat([authenticator, sha256(clientData)]), { key, dsaEncoding: "der" }, signature)
      ? signCount
      : null;
  } catch {
    return null;
  }
}

// The stored passkey, or null when none is registered. A file that is not one is bad_passkey_file.
export async function loadPasskey(path: string): Promise<Passkey | null> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (isCoded(error, "ENOENT")) return null;
    throw error;
  });
  if (text === null) return null;
  try {
    const { id, publicKey, signCount } = JSON.parse(text) as Partial<Passkey>;
    if (bytes(id) !== null && bytes(publicKey) !== null && Number.isInteger(signCount) && (signCount ?? -1) >= 0)
      return { id, publicKey, signCount } as Passkey;
  } catch {
    // Refused below.
  }
  throw refusal("bad_passkey_file");
}

// Writes the passkey whole, 0600, by a rename, so a crash leaves the old one or the new one.
export async function savePasskey(path: string, passkey: Passkey): Promise<void> {
  const next = `${path}.next`;
  await unlink(next).catch(() => {});
  await writeFile(next, `${JSON.stringify(passkey)}\n`, { mode: 0o600, flag: "wx" });
  await rename(next, path);
}
