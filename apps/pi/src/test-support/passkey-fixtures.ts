import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";

// A software authenticator for the passkey's tests (web-passkey.test.ts, web.test.ts): it makes
// what a phone's browser posts to `pi web`, ES256 on P-256, as WebAuthn lays it out, so each test
// can change one field and see it refused.

const sha256 = (data: Buffer | string): Buffer => createHash("sha256").update(data).digest();
const b64 = (data: Buffer): string => data.toString("base64url");

export const UP = 0x01;
export const UV = 0x04;
const AT = 0x40;

export type Authenticator = { id: Buffer; privateKey: KeyObject; spki: Buffer };

export function authenticator(curve = "prime256v1"): Authenticator {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: curve });
  return {
    id: Buffer.from(`credential-${curve}-${Math.random()}`),
    privateKey,
    spki: publicKey.export({ format: "der", type: "spki" }),
  };
}

type Data = { type: string; challenge: string; origin: string; crossOrigin?: boolean };
const clientData = (data: Data): Buffer => Buffer.from(JSON.stringify(data));

function authenticatorData(rpId: string, flags: number, count: number, attested?: Buffer): Buffer {
  const head = Buffer.alloc(37);
  sha256(rpId).copy(head, 0);
  head[32] = flags;
  head.writeUInt32BE(count, 33);
  if (attested === undefined) return head;
  const length = Buffer.alloc(2);
  length.writeUInt16BE(attested.length);
  // The AAGUID (zeros, as attestation `none` gives), the id's length, the id, and a stand-in for
  // the CBOR key, which the server never reads.
  return Buffer.concat([head, Buffer.alloc(16), length, attested, Buffer.from([0xa5, 0x01, 0x02])]);
}

export type Options = {
  rpId?: string;
  origin?: string;
  type?: string;
  flags?: number;
  count?: number;
  crossOrigin?: boolean;
};

// The registration body: the client data, the authenticator data with the credential's id, and
// the public key as `getPublicKey()` gives it.
export function registration(
  device: Authenticator,
  host: string,
  challenge: string,
  options: Options & { alg?: number; attestedId?: Buffer } = {},
) {
  const data = clientData({
    type: options.type ?? "webauthn.create",
    challenge,
    origin: options.origin ?? `https://${host}`,
    ...(options.crossOrigin === undefined ? {} : { crossOrigin: options.crossOrigin }),
  });
  return {
    id: b64(device.id),
    clientDataJSON: b64(data),
    authenticatorData: b64(
      authenticatorData(
        options.rpId ?? host,
        options.flags ?? UP | UV | AT,
        options.count ?? 0,
        options.attestedId ?? device.id,
      ),
    ),
    publicKey: b64(device.spki),
    publicKeyAlgorithm: options.alg ?? -7,
  };
}

// The assertion body: signed by `signer` (the device's own key unless a test forges one).
export function assertion(
  device: Authenticator,
  host: string,
  challenge: string,
  options: Options & { signer?: KeyObject } = {},
) {
  const data = clientData({
    type: options.type ?? "webauthn.get",
    challenge,
    origin: options.origin ?? `https://${host}`,
    ...(options.crossOrigin === undefined ? {} : { crossOrigin: options.crossOrigin }),
  });
  const auth = authenticatorData(options.rpId ?? host, options.flags ?? UP | UV, options.count ?? 0);
  return {
    id: b64(device.id),
    clientDataJSON: b64(data),
    authenticatorData: b64(auth),
    signature: b64(sign("sha256", Buffer.concat([auth, sha256(data)]), options.signer ?? device.privateKey)),
  };
}
