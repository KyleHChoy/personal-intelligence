// Readings, where the spec leaves a detail open. The implementation conforms to these.
// 1. The cipher is AES-256-GCM with a fresh random 12-byte nonce for every seal and a 16-byte
//    tag. The associated data is canonicalBytes(bound). known-answers.test.ts pins this.
// 2. An Envelope is { v: 1, nonce, ciphertext, tag }, each part standard base64 with padding.
//    The ciphertext is as long as the plaintext.
// 3. A refusal is a throw. seal and open return nothing on a refusal.
// 4. open refuses an envelope that fails the contract's Envelope schema, and a nonce or tag of
//    any other length, before it decrypts anything.
// 5. seal and open refuse a key that is not base64 of 32 bytes, and a binding that fails the
//    contract's CipherBinding schema (no evidence id, or an empty field).
// 6. What is thrown holds no key and no plaintext, in any encoding.
// 7. Only the canonical base64 spelling is accepted, of each envelope part and of a key: the
//    one that encoding the bytes gives back. Any other spelling of the same bytes is refused, so
//    no changed envelope reads as the one that was sealed and no key has two names.
// 8. The binding's field names the thing sealed: PAYLOAD_FIELD from the contracts for an item's
//    own payload, "claim:<claim id>" for a claim's payload. Two envelopes under one key and one
//    binding are interchangeable, so a caller that seals two things for one item gives each its
//    own field.
import { randomBytes } from "node:crypto";
import type { CipherBinding, DataKey } from "@intelligence/contracts";
import { Envelope } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { open, seal } from "./envelope.ts";
import {
  bound,
  firstBytes,
  flipBit,
  formsOf,
  freshKey,
  otherSpelling,
  PAYLOAD_FIELD,
  rawOf,
  sameBytes,
  shownBy,
  textOf,
  thrownBy,
  utf8,
} from "./test-support/samples.ts";

const here = bound("ev-a", PAYLOAD_FIELD);
const message = utf8("Maya said the round closes in March.");

const sealed = (key: DataKey, plaintext: Uint8Array = message, binding: CipherBinding = here): Envelope =>
  seal(key, plaintext, binding);
const lengthOf = (base64: string): number => Buffer.from(base64, "base64").length;

describe("seal", () => {
  it("two seals with one key and plaintext produce different envelopes", () => {
    const key = freshKey();
    const first = sealed(key);
    const second = sealed(key);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(second.tag).not.toBe(first.tag);
  });

  it("nonces never repeat across many seals under one key", () => {
    const key = freshKey();
    const nonces = new Set<string>();
    for (let count = 0; count < 20_000; count += 1) nonces.add(sealed(key).nonce);
    expect(nonces.size).toBe(20_000);
  });

  it("nonces never repeat across keys and bindings", () => {
    const nonces = new Set<string>();
    for (let count = 0; count < 2_000; count += 1) nonces.add(sealed(freshKey(), message, bound(`ev-${count}`)).nonce);
    expect(nonces.size).toBe(2_000);
  });

  it("an envelope has the contract's shape, a 12-byte nonce and a 16-byte tag", () => {
    const envelope = sealed(freshKey());
    expect(Envelope.safeParse(envelope).success).toBe(true);
    expect(envelope.v).toBe(1);
    expect(lengthOf(envelope.nonce)).toBe(12);
    expect(lengthOf(envelope.tag)).toBe(16);
    expect(lengthOf(envelope.ciphertext)).toBe(message.length);
    for (const part of [envelope.nonce, envelope.ciphertext, envelope.tag]) {
      expect(Buffer.from(part, "base64").toString("base64")).toBe(part);
    }
  });

  it("the envelope does not hold the plaintext or the key", () => {
    const key = freshKey();
    const envelope = sealed(key);
    const written = JSON.stringify(envelope);
    for (const form of [...formsOf(message), ...formsOf(rawOf(key))]) expect(written).not.toContain(form);
  });

  it("sealing leaves the plaintext it was given unchanged", () => {
    const plaintext = utf8("unchanged");
    sealed(freshKey(), plaintext);
    expect(textOf(plaintext)).toBe("unchanged");
  });
});

describe("open", () => {
  it("a sealed payload opens with its key and its binding", () => {
    const key = freshKey();
    expect(textOf(open(key, sealed(key), here))).toBe(textOf(message));
  });

  it("an empty payload and a large binary payload both open to exactly what was sealed", () => {
    const key = freshKey();
    const empty = new Uint8Array(0);
    const large = randomBytes(256 * 1024);
    expect(open(key, sealed(key, empty), here)).toHaveLength(0);
    expect(sameBytes(open(key, sealed(key, large), here), large)).toBe(true);
  });

  it("a different key is refused", () => {
    const envelope = sealed(freshKey());
    expect(() => open(freshKey(), envelope, here)).toThrow();
  });

  it("a key that differs in one bit is refused", () => {
    const key = freshKey();
    const envelope = sealed(key);
    for (let index = 0; index < 32; index += 1) {
      expect(() => open(flipBit(key, index) as DataKey, envelope, here)).toThrow();
    }
  });

  it("a changed ciphertext is refused, whichever byte changed", () => {
    const key = freshKey();
    const envelope = sealed(key);
    for (let index = 0; index < message.length; index += 1) {
      expect(() => open(key, { ...envelope, ciphertext: flipBit(envelope.ciphertext, index) }, here)).toThrow();
    }
  });

  it("a shortened or lengthened ciphertext is refused", () => {
    const key = freshKey();
    const envelope = sealed(key);
    const longer = Buffer.concat([Buffer.from(envelope.ciphertext, "base64"), Buffer.from([0])]).toString("base64");
    expect(() =>
      open(key, { ...envelope, ciphertext: firstBytes(envelope.ciphertext, message.length - 1) }, here),
    ).toThrow();
    expect(() => open(key, { ...envelope, ciphertext: longer }, here)).toThrow();
    expect(() => open(key, { ...envelope, ciphertext: "" }, here)).toThrow();
  });

  it("a changed nonce is refused, whichever byte changed", () => {
    const key = freshKey();
    const envelope = sealed(key);
    for (let index = 0; index < 12; index += 1) {
      expect(() => open(key, { ...envelope, nonce: flipBit(envelope.nonce, index) }, here)).toThrow();
    }
  });

  it("a changed tag is refused, whichever byte changed", () => {
    const key = freshKey();
    const envelope = sealed(key);
    for (let index = 0; index < 16; index += 1) {
      expect(() => open(key, { ...envelope, tag: flipBit(envelope.tag, index) }, here)).toThrow();
    }
  });

  // A shortened GCM tag is a prefix of the full one, and a decipher that takes whatever length
  // it is given accepts it. Each shorter tag makes a forgery easier to guess.
  it("a tag cut short is refused, though its bytes are right", () => {
    const key = freshKey();
    const envelope = sealed(key);
    for (const length of [0, 1, 4, 8, 12, 13, 14, 15]) {
      expect(() => open(key, { ...envelope, tag: firstBytes(envelope.tag, length) }, here)).toThrow();
    }
  });

  it("a nonce of another length is refused", () => {
    const key = freshKey();
    const envelope = sealed(key);
    const longer = Buffer.concat([Buffer.from(envelope.nonce, "base64"), Buffer.alloc(4)]).toString("base64");
    expect(() => open(key, { ...envelope, nonce: firstBytes(envelope.nonce, 8) }, here)).toThrow();
    expect(() => open(key, { ...envelope, nonce: longer }, here)).toThrow();
    expect(() => open(key, { ...envelope, nonce: "" }, here)).toThrow();
  });

  it("parts taken from two envelopes of one key do not open", () => {
    const key = freshKey();
    const first = sealed(key);
    const second = sealed(key);
    expect(() => open(key, { ...first, ciphertext: second.ciphertext }, here)).toThrow();
    expect(() => open(key, { ...first, tag: second.tag }, here)).toThrow();
    expect(() => open(key, { ...first, nonce: second.nonce }, here)).toThrow();
  });

  it("a payload sealed for one evidence id does not open as another", () => {
    const key = freshKey();
    const envelope = sealed(key, message, bound("ev-a", "payload"));
    expect(() => open(key, envelope, bound("ev-b", "payload"))).toThrow();
  });

  it("a payload sealed for one field does not open as another field of the same item", () => {
    const key = freshKey();
    const envelope = sealed(key, message, bound("ev-a", "payload"));
    expect(() => open(key, envelope, bound("ev-a", "reference"))).toThrow();
  });

  it("two bindings whose parts run together the same way are still different bindings", () => {
    const key = freshKey();
    const envelope = sealed(key, message, bound("ev-a", "bpayload"));
    expect(() => open(key, envelope, bound("ev-ab", "payload"))).toThrow();
    expect(() => open(key, envelope, bound("ev-abpayload", "x"))).toThrow();
  });

  // The cipher has decrypted everything by the time it checks the tag. None of it may leave,
  // in the error or anywhere else.
  it("a refused open hands over none of the plaintext, though only the last byte was changed", () => {
    const key = freshKey();
    const phrase = "the round closes in March; ";
    const large = utf8(phrase.repeat(2048));
    const envelope = sealed(key, large);
    expect(sameBytes(open(key, envelope, here), large)).toBe(true);
    const refusal = thrownBy(() =>
      open(key, { ...envelope, ciphertext: flipBit(envelope.ciphertext, large.length - 1) }, here),
    );
    const shown = shownBy(refusal);
    for (const form of formsOf(utf8(phrase))) expect(shown).not.toContain(form);
  });

  it("another base64 spelling of the same tag or ciphertext is refused", () => {
    const key = freshKey();
    // Ten bytes, so the ciphertext ends in padding, as a 16-byte tag does.
    const envelope = sealed(key, utf8("ten bytes!"));
    expect(textOf(open(key, envelope, here))).toBe("ten bytes!");
    expect(() => open(key, { ...envelope, tag: otherSpelling(envelope.tag) }, here)).toThrow();
    expect(() => open(key, { ...envelope, ciphertext: otherSpelling(envelope.ciphertext) }, here)).toThrow();
  });

  it.each([
    ["without its padding", (part: string): string => part.replace(/=+$/, "")],
    ["with one more padding character", (part: string): string => `${part}=`],
    ["with a line break after it", (part: string): string => `${part}\n`],
    ["with a space inside it", (part: string): string => `${part.slice(0, 4)} ${part.slice(4)}`],
    ["in the URL-safe alphabet", (part: string): string => Buffer.from(part, "base64").toString("base64url")],
  ])("R2: an envelope part written %s is refused, though it decodes to the same bytes", (_name, respell) => {
    const key = freshKey();
    let envelope = sealed(key, utf8("ten bytes!"));
    // A tag with a character that the URL-safe alphabet writes differently.
    while (!/[+/]/.test(envelope.tag)) envelope = sealed(key, utf8("ten bytes!"));
    expect(textOf(open(key, envelope, here))).toBe("ten bytes!");
    let tried = 0;
    for (const name of ["nonce", "ciphertext", "tag"] as const) {
      const respelled = respell(envelope[name]);
      if (respelled === envelope[name]) continue;
      expect(sameBytes(Buffer.from(respelled, "base64"), Buffer.from(envelope[name], "base64"))).toBe(true);
      expect(() => open(key, { ...envelope, [name]: respelled }, here)).toThrow();
      tried += 1;
    }
    expect(tried).toBeGreaterThan(0);
  });

  it("a claim's payload, bound with claim:<claim id>, opens as no other claim and not as the item's payload", () => {
    const key = freshKey();
    const envelope = sealed(key, message, bound("ev-a", "claim:c-1"));
    expect(textOf(open(key, envelope, bound("ev-a", "claim:c-1")))).toBe(textOf(message));
    expect(() => open(key, envelope, bound("ev-a", "claim:c-2"))).toThrow();
    expect(() => open(key, envelope, bound("ev-a", PAYLOAD_FIELD))).toThrow();
    expect(() => open(key, envelope, bound("ev-b", "claim:c-1"))).toThrow();
  });

  // This is why the field names the thing sealed: under one key and one binding nothing tells
  // two envelopes apart.
  it("two things sealed under one key and one binding open in each other's place", () => {
    const key = freshKey();
    const shared = bound("ev-a", "claim:c-1");
    const first = sealed(key, utf8("first"), shared);
    const second = sealed(key, utf8("second"), shared);
    expect(textOf(open(key, first, shared))).toBe("first");
    expect(textOf(open(key, second, shared))).toBe("second");
  });

  it("an envelope of another version, with an extra part or with a part missing is refused", () => {
    const key = freshKey();
    const envelope = sealed(key);
    const { tag: _tag, ...noTag } = envelope;
    expect(() => open(key, { ...envelope, v: 2 } as unknown as Envelope, here)).toThrow();
    expect(() => open(key, { ...envelope, key } as unknown as Envelope, here)).toThrow();
    expect(() => open(key, noTag as unknown as Envelope, here)).toThrow();
    expect(() => open(key, { ...envelope, nonce: "not base64!" }, here)).toThrow();
    expect(() => open(key, undefined as unknown as Envelope, here)).toThrow();
  });

  it("a binding with its keys in another order is the same binding", () => {
    const key = freshKey();
    const envelope = sealed(key, message, { evidenceId: here.evidenceId, field: here.field });
    const reordered: CipherBinding = { field: here.field, evidenceId: here.evidenceId };
    expect(textOf(open(key, envelope, reordered))).toBe(textOf(message));
  });
});

describe("fail closed", () => {
  const badKeys: [string, string][] = [
    ["a 16-byte key", Buffer.alloc(16, 7).toString("base64")],
    ["a 24-byte key", Buffer.alloc(24, 7).toString("base64")],
    ["a 31-byte key", Buffer.alloc(31, 7).toString("base64")],
    ["a 33-byte key", Buffer.alloc(33, 7).toString("base64")],
    ["an empty key", ""],
    ["a key that is not base64", "!".repeat(44)],
    ["a hex key", "07".repeat(32)],
  ];

  it.each(badKeys)("seal refuses %s", (_name, bad) => {
    expect(Envelope.safeParse(sealed(freshKey())).success).toBe(true);
    expect(() => seal(bad as DataKey, message, here)).toThrow();
  });

  it.each(badKeys)("open refuses %s", (_name, bad) => {
    const envelope = sealed(freshKey());
    expect(() => open(bad as DataKey, envelope, here)).toThrow();
  });

  it("seal and open refuse another spelling of a 32-byte key, so no key has two names", () => {
    const key = freshKey();
    const respelled = otherSpelling(key) as DataKey;
    expect(respelled).toHaveLength(44);
    expect(sameBytes(rawOf(respelled), rawOf(key))).toBe(true);
    const envelope = sealed(key);
    expect(textOf(open(key, envelope, here))).toBe(textOf(message));
    expect(() => seal(respelled, message, here)).toThrow();
    expect(() => open(respelled, envelope, here)).toThrow();
  });

  it("seal and open refuse a missing key", () => {
    const envelope = sealed(freshKey());
    expect(() => seal(undefined as unknown as DataKey, message, here)).toThrow();
    expect(() => open(undefined as unknown as DataKey, envelope, here)).toThrow();
  });

  it("seal refuses a binding with no evidence id or no field, so nothing is sealed unbound", () => {
    const key = freshKey();
    expect(Envelope.safeParse(sealed(key)).success).toBe(true);
    expect(() => seal(key, message, { evidenceId: "", field: "payload" } as CipherBinding)).toThrow();
    expect(() => seal(key, message, { evidenceId: here.evidenceId, field: "" })).toThrow();
    expect(() => seal(key, message, { evidenceId: here.evidenceId } as CipherBinding)).toThrow();
    expect(() => seal(key, message, undefined as unknown as CipherBinding)).toThrow();
  });

  it("open refuses a missing binding", () => {
    const key = freshKey();
    const envelope = sealed(key);
    expect(textOf(open(key, envelope, here))).toBe(textOf(message));
    expect(() => open(key, envelope, undefined as unknown as CipherBinding)).toThrow();
    expect(() => open(key, envelope, { evidenceId: here.evidenceId } as CipherBinding)).toThrow();
  });
});

describe("errors", () => {
  it("a refused open shows no key and no plaintext", () => {
    const key = freshKey();
    const other = freshKey();
    const envelope = sealed(key);
    const refusals = [
      thrownBy(() => open(other, envelope, here)),
      thrownBy(() => open(key, { ...envelope, tag: flipBit(envelope.tag, 0) }, here)),
      thrownBy(() => open(key, envelope, bound("ev-b"))),
    ];
    for (const refusal of refusals) {
      const shown = shownBy(refusal);
      for (const secret of [...formsOf(rawOf(key)), ...formsOf(rawOf(other)), ...formsOf(message)]) {
        expect(shown).not.toContain(secret);
      }
    }
  });

  it("a refused key is not repeated in the error", () => {
    const short = Buffer.alloc(31, 0x5a);
    const bad = short.toString("base64");
    expect(Envelope.safeParse(sealed(freshKey())).success).toBe(true);
    const refusal = thrownBy(() => seal(bad as DataKey, message, here));
    const shown = shownBy(refusal);
    for (const secret of [...formsOf(short), ...formsOf(message)]) expect(shown).not.toContain(secret);
  });
});
