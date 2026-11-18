// Known answers, so the package cannot agree with itself and still be wrong.
//
// A published vector cannot be fed straight through the public API: seal picks its own nonce,
// the associated data is always canonicalBytes(bound), and deriveContentKey takes 32-byte keys.
// So the check is a chain. First the plain Node primitives in test-support/reference.ts are held
// to the published vectors (RFC 5869 for HKDF-SHA-256, the GCM specification for AES-256-GCM).
// Then seal, open and deriveContentKey are held to those primitives, in both directions, and to
// the published ciphertext, which in GCM does not depend on the associated data.
//
// This file imports canonicalBytes from @intelligence/signing, which the package under test
// needs as well.
import { randomBytes } from "node:crypto";
import type { DataKey, Envelope } from "@intelligence/contracts";
import { canonicalBytes } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import { deriveContentKey, open, seal } from "./envelope.ts";
import { gcmOpen, gcmSeal, hkdfSha256 } from "./test-support/reference.ts";
import { bound, freshKey, keyFilled, keyFrom, pick, rawOf, sameBytes, utf8 } from "./test-support/samples.ts";
import { contentKeyInfo, derivedVectors, gcmVectors, hkdfVectors } from "./test-support/vectors.ts";

const hex = (value: string): Buffer => Buffer.from(value, "hex");
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const here = bound("ev-a", "payload");
const message = utf8("Maya said the round closes in March.");
const none = new Uint8Array(0);
const info = utf8(contentKeyInfo);

describe("the reference primitives against published vectors", () => {
  it.each(hkdfVectors)("HKDF-SHA-256 gives the output of $name", (vector) => {
    const output = hkdfSha256(hex(vector.input), hex(vector.salt), hex(vector.info), vector.length);
    expect(output.toString("hex")).toBe(vector.output);
  });

  it.each(gcmVectors)("AES-256-GCM gives the ciphertext and tag of $name", (vector) => {
    const made = gcmSeal(hex(vector.key), hex(vector.nonce), hex(vector.plaintext), hex(vector.associated));
    expect(made.ciphertext.toString("hex")).toBe(vector.ciphertext);
    expect(made.tag.toString("hex")).toBe(vector.tag);
    const opened = gcmOpen(
      hex(vector.key),
      hex(vector.nonce),
      hex(vector.ciphertext),
      hex(vector.tag),
      hex(vector.associated),
    );
    expect(opened.toString("hex")).toBe(vector.plaintext);
  });
});

describe("seal and open against AES-256-GCM", () => {
  it("seal's ciphertext and tag are AES-256-GCM over canonicalBytes of the binding", () => {
    const key = freshKey();
    const envelope: Envelope = seal(key, message, here);
    const nonce = Buffer.from(envelope.nonce, "base64");
    const expected = gcmSeal(rawOf(key), nonce, message, canonicalBytes(here));
    expect(envelope.ciphertext).toBe(base64(expected.ciphertext));
    expect(envelope.tag).toBe(base64(expected.tag));
  });

  it("what seal makes opens with plain AES-256-GCM", () => {
    const key = freshKey();
    const envelope: Envelope = seal(key, message, here);
    const opened = gcmOpen(
      rawOf(key),
      Buffer.from(envelope.nonce, "base64"),
      Buffer.from(envelope.ciphertext, "base64"),
      Buffer.from(envelope.tag, "base64"),
      canonicalBytes(here),
    );
    expect(sameBytes(opened, message)).toBe(true);
  });

  it("open accepts what plain AES-256-GCM made over canonicalBytes of the binding", () => {
    const key = freshKey();
    const nonce = randomBytes(12);
    const made = gcmSeal(rawOf(key), nonce, message, canonicalBytes(here));
    const envelope: Envelope = {
      v: 1,
      nonce: base64(nonce),
      ciphertext: base64(made.ciphertext),
      tag: base64(made.tag),
    };
    expect(sameBytes(open(key, envelope, here), message)).toBe(true);
  });

  it("open refuses an envelope sealed with no associated data", () => {
    const key = freshKey();
    const nonce = randomBytes(12);
    const envelopeOver = (associated: Uint8Array): Envelope => {
      const made = gcmSeal(rawOf(key), nonce, message, associated);
      return { v: 1, nonce: base64(nonce), ciphertext: base64(made.ciphertext), tag: base64(made.tag) };
    };
    expect(sameBytes(open(key, envelopeOver(canonicalBytes(here)), here), message)).toBe(true);
    expect(() => open(key, envelopeOver(none), here)).toThrow();
  });

  // The ciphertext of GCM depends on the key, the nonce and the plaintext only, so the published
  // ciphertext must open to the published plaintext once the tag covers our binding.
  it.each(gcmVectors.slice(1))(
    "R2: open gives the published plaintext of $name for its key, nonce and ciphertext",
    (vector) => {
      const key: DataKey = keyFrom(hex(vector.key));
      const { ciphertext, tag } = gcmSeal(
        hex(vector.key),
        hex(vector.nonce),
        hex(vector.plaintext),
        canonicalBytes(here),
      );
      expect(ciphertext.toString("hex")).toBe(vector.ciphertext);
      const envelope: Envelope = {
        v: 1,
        nonce: base64(hex(vector.nonce)),
        ciphertext: base64(hex(vector.ciphertext)),
        tag: base64(tag),
      };
      expect(Buffer.from(open(key, envelope, here)).toString("hex")).toBe(vector.plaintext);
    },
  );

  it("the published tag, which covers other associated data, does not open under a binding", () => {
    const vector = pick(gcmVectors, 3);
    const key = keyFrom(hex(vector.key));
    const envelopeWith = (tag: Uint8Array): Envelope => ({
      v: 1,
      nonce: base64(hex(vector.nonce)),
      ciphertext: base64(hex(vector.ciphertext)),
      tag: base64(tag),
    });
    const ours = gcmSeal(hex(vector.key), hex(vector.nonce), hex(vector.plaintext), canonicalBytes(here)).tag;
    expect(Buffer.from(open(key, envelopeWith(ours), here)).toString("hex")).toBe(vector.plaintext);
    expect(() => open(key, envelopeWith(hex(vector.tag)), here)).toThrow();
  });
});

describe("deriveContentKey against HKDF-SHA-256", () => {
  const [a, b, c] = [keyFilled(0x11), keyFilled(0x22), keyFilled(0x33)];

  it("two and three known keys give the pinned keys", () => {
    expect(rawOf(deriveContentKey([a, b])).toString("hex")).toBe(derivedVectors.two);
    expect(rawOf(deriveContentKey([a, b, c])).toString("hex")).toBe(derivedVectors.three);
  });

  it("the label is intelligence/content-key/v1, as UTF-8", () => {
    expect(contentKeyInfo).toBe("intelligence/content-key/v1");
    expect(Buffer.from(info).toString("hex")).toBe("696e74656c6c6967656e63652f636f6e74656e742d6b65792f7631");
  });

  it("the pinned keys are HKDF-SHA-256 over the keys, with an empty salt and the label as info", () => {
    expect(hkdfSha256(Buffer.concat([rawOf(a), rawOf(b)]), none, info, 32).toString("hex")).toBe(derivedVectors.two);
    expect(hkdfSha256(Buffer.concat([rawOf(a), rawOf(b), rawOf(c)]), none, info, 32).toString("hex")).toBe(
      derivedVectors.three,
    );
  });

  it("the pinned keys do not depend on the order the keys are given in", () => {
    expect(rawOf(deriveContentKey([b, a])).toString("hex")).toBe(derivedVectors.two);
    expect(rawOf(deriveContentKey([c, a, b])).toString("hex")).toBe(derivedVectors.three);
  });

  it("a derivation with no label, or with another label, gives another key", () => {
    const joined = Buffer.concat([rawOf(a), rawOf(b)]);
    const derived: DataKey = deriveContentKey([a, b]);
    expect(derived).toBe(keyFrom(hkdfSha256(joined, none, info, 32)));
    expect(derived).not.toBe(keyFrom(hkdfSha256(joined, none, none, 32)));
    expect(derived).not.toBe(keyFrom(hkdfSha256(joined, none, utf8("intelligence/content-key/v2"), 32)));
    expect(derived).not.toBe(keyFrom(hkdfSha256(joined, info, none, 32)));
  });

  it("one key gives that key itself, not a key derived from it", () => {
    const derived: DataKey = deriveContentKey([a]);
    expect(derived).toBe(a);
    expect(derived).not.toBe(keyFrom(hkdfSha256(rawOf(a), none, info, 32)));
  });

  it("any keys give HKDF-SHA-256 over those keys in ascending byte order, with the label", () => {
    for (let round = 0; round < 50; round += 1) {
      const keys = Array.from({ length: 2 + (round % 5) }, () => freshKey());
      const joined = Buffer.concat(keys.map(rawOf).sort(Buffer.compare));
      const derived: DataKey = deriveContentKey(keys);
      expect(derived).toBe(keyFrom(hkdfSha256(joined, none, info, 32)));
    }
  });
});
