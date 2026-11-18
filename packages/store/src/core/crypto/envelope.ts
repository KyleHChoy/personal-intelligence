import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { CipherBinding, type DataKey, Envelope } from "@intelligence/contracts";
import { canonicalBytes } from "@intelligence/personal-core";
import { CryptoError } from "./errors.ts";

// AES-256-GCM with a fresh 96-bit nonce per seal and a 128-bit tag. The
// binding travels as additional authenticated data, so a payload moved to
// another item or field does not open.
const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const NO_SALT = new Uint8Array(0);
// The label of the derivation. It is the version: a later derivation takes
// another label, and the two coexist.
const CONTENT_KEY_INFO = Buffer.from("intelligence/content-key/v1", "utf8");

// The bytes of a data key. The caller zeroes the buffer when it is done.
function keyBytes(key: DataKey): Buffer {
  if (typeof key !== "string") throw new CryptoError("bad_key");
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== KEY_BYTES || bytes.toString("base64") !== key) {
    bytes.fill(0);
    throw new CryptoError("bad_key");
  }
  return bytes;
}

// Takes ownership of `bytes` and zeroes it, whatever its length. It is read
// through a view, so no second copy of the raw key is made.
function dataKey(bytes: Uint8Array): DataKey {
  try {
    if (bytes.length !== KEY_BYTES) throw new CryptoError("bad_key");
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64") as DataKey;
  } finally {
    bytes.fill(0);
  }
}

function bindingBytes(bound: CipherBinding): Uint8Array {
  const parsed = CipherBinding.safeParse(bound);
  if (!parsed.success) throw new CryptoError("bad_binding");
  return canonicalBytes(parsed.data);
}

// One base64 part of an envelope. Only the canonical spelling is accepted, so
// no changed envelope reads as the one that was sealed.
function part(text: string): Buffer {
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text) throw new CryptoError("bad_envelope");
  return bytes;
}

export function seal(key: DataKey, plaintext: Uint8Array, bound: CipherBinding): Envelope {
  const aad = bindingBytes(bound);
  const secret = keyBytes(key);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(CIPHER, secret, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      v: 1,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  } finally {
    secret.fill(0);
  }
}

export function open(key: DataKey, e: Envelope, bound: CipherBinding): Uint8Array {
  const parsed = Envelope.safeParse(e);
  if (!parsed.success) throw new CryptoError("bad_envelope");
  const nonce = part(parsed.data.nonce);
  const tag = part(parsed.data.tag);
  const ciphertext = part(parsed.data.ciphertext);
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new CryptoError("bad_envelope");

  const aad = bindingBytes(bound);
  const secret = keyBytes(key);
  let head: Buffer | undefined;
  try {
    const decipher = createDecipheriv(CIPHER, secret, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    // GCM gives every byte from `update`. `final` only checks the tag, and
    // nothing is returned before it passes. The plaintext is not copied.
    head = decipher.update(ciphertext);
    decipher.final();
    return new Uint8Array(head.buffer, head.byteOffset, head.byteLength);
  } catch {
    head?.fill(0);
    throw new CryptoError("open_failed");
  } finally {
    secret.fill(0);
  }
}

// One key gives that key itself. Several give HKDF-SHA-256 over all of them,
// joined in ascending byte order, with no salt and the label as info, so the
// order given does not matter. Every key is 32 bytes, so the joined input has
// one reading, and a key given twice counts twice.
export function deriveContentKey(keys: DataKey[]): DataKey {
  if (!Array.isArray(keys) || keys.length === 0) throw new CryptoError("no_keys");
  const parts: Buffer[] = [];
  try {
    for (const key of keys) parts.push(keyBytes(key));
    if (parts.length === 1) return keys[0] as DataKey;
    const joined = Buffer.concat(parts.sort(Buffer.compare));
    try {
      return dataKey(new Uint8Array(hkdfSync("sha256", joined, NO_SALT, CONTENT_KEY_INFO, KEY_BYTES)));
    } finally {
      joined.fill(0);
    }
  } finally {
    for (const bytes of parts) bytes.fill(0);
  }
}
