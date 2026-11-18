// Synthetic values and small helpers shared by the crypto tests. Nothing here is real data.
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { CipherBinding, DataKey } from "@intelligence/contracts";

// The field an item's own payload is sealed under.
export const PAYLOAD_FIELD = "payload";

// A data key whose 32 bytes are all `byte`.
export const keyFilled = (byte: number): DataKey => DataKey.parse(Buffer.alloc(32, byte).toString("base64"));
export const freshKey = (): DataKey => DataKey.parse(randomBytes(32).toString("base64"));
export const rawOf = (key: DataKey): Buffer => Buffer.from(key, "base64");
export const keyFrom = (raw: Uint8Array): DataKey => DataKey.parse(Buffer.from(raw).toString("base64"));

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// A binding's field names the thing sealed: PAYLOAD_FIELD for an item's own payload,
// "claim:<claim id>" for a claim's payload.
export const bound = (evidenceId: string, field: string = PAYLOAD_FIELD): CipherBinding =>
  CipherBinding.parse({ evidenceId, field });

// The same base64 with one bit of one byte changed.
export const flipBit = (base64: string, index: number): string => {
  const bytes = Buffer.from(base64, "base64");
  bytes.writeUInt8(bytes.readUInt8(index) ^ 0x01, index);
  return bytes.toString("base64");
};

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Another spelling of the same bytes: the bits of the last character that carry no data are
// changed. It needs a value whose length is not a multiple of three bytes, so that it ends in
// padding. Node's decoder reads both spellings as the same bytes.
export const otherSpelling = (base64: string): string => {
  const last = base64.replace(/=+$/, "").length - 1;
  const spelled =
    base64.slice(0, last) + alphabet.charAt(alphabet.indexOf(base64.charAt(last)) | 1) + base64.slice(last + 1);
  if (
    !base64.endsWith("=") ||
    spelled === base64 ||
    !Buffer.from(spelled, "base64").equals(Buffer.from(base64, "base64"))
  ) {
    throw new Error("no other spelling of this value");
  }
  return spelled;
};

// The first `length` bytes of a base64 value, as base64.
export const firstBytes = (base64: string, length: number): string =>
  Buffer.from(base64, "base64").subarray(0, length).toString("base64");

export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

export const pick = <T>(list: readonly T[], index: number): T => {
  const value = list[index];
  if (value === undefined) throw new Error("no such sample");
  return value;
};

// What a synchronous call threw. Fails the test if it returned.
export const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (thrown) {
    return thrown;
  }
  throw new Error("expected a refusal, but the call returned");
};

// Every run of bytes a value holds, however deep: byte arrays, buffers and lists of numbers.
const bytesIn = (value: unknown, seen = new Set<unknown>(), depth = 0): Buffer[] => {
  if (typeof value !== "object" || value === null || seen.has(value) || depth > 6) return [];
  seen.add(value);
  if (ArrayBuffer.isView(value)) return [Buffer.from(value.buffer, value.byteOffset, value.byteLength)];
  if (value instanceof ArrayBuffer) return [Buffer.from(value)];
  if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "number"))
    return [Buffer.from(value)];
  return Reflect.ownKeys(value).flatMap((key) => {
    try {
      return bytesIn(Reflect.get(value, key), seen, depth + 1);
    } catch {
      return [];
    }
  });
};

// Everything a thrown value could show a reader of a log or an error report: its text, and any
// bytes it carries, as hex and as characters.
export const shownBy = (thrown: unknown): string => {
  const parts = [String(thrown), inspect(thrown, { depth: 8, showHidden: true }), JSON.stringify(thrown) ?? ""];
  if (thrown instanceof Error) parts.push(thrown.message, thrown.stack ?? "");
  for (const bytes of bytesIn(thrown)) parts.push(bytes.toString("hex"), bytes.toString("latin1"));
  return parts.join("\n");
};

// The forms a secret could take in text.
export const formsOf = (secret: Uint8Array): string[] => {
  const bytes = Buffer.from(secret);
  return [bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex"), bytes.toString("latin1")];
};
