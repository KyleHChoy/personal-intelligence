// Node's primitives called directly, kept apart from the package under test. known-answers.test.ts
// first checks these against published vectors, then checks the package against these, so an
// implementation that agrees only with itself fails.
import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";

export const gcmSeal = (
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  associated: Uint8Array,
): { ciphertext: Buffer; tag: Buffer } => {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
};

// Throws when the tag does not match.
export const gcmOpen = (
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  associated: Uint8Array,
): Buffer => {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  decipher.setAAD(associated);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

export const hkdfSha256 = (input: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Buffer =>
  Buffer.from(hkdfSync("sha256", input, salt, info, length));
