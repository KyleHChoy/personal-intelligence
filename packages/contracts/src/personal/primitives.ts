import { z } from "zod";
import { EntityId, EventId, Handle, MessageId } from "./ids.ts";

// The value shapes every feature module shares. A leaf: it imports only zod and ids.ts, so a small
// module never imports a hub such as owner.ts or work.ts for one type.

// 64 lower-case hexadecimal characters: a SHA-256 or a keyed HMAC-SHA-256 the store makes.
export const HEX64 = /^[0-9a-f]{64}$/;
export const Hex64 = z.string().regex(HEX64);
export type Hex64 = z.infer<typeof Hex64>;

// A SHA-256 of a text or a definition, as the pins hold it.
export const Sha256 = Hex64;
export type Sha256 = z.infer<typeof Sha256>;

// A keyed `fact` fingerprint of a fact key: what a fact veto holds by.
export const FactKeyFp = Hex64;
export type FactKeyFp = z.infer<typeof FactKeyFp>;

// A PersonalRef as a client names one, each id or a one-time handle. Never stored: the store resolves
// it to a PersonalRef first.
export const ClientRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("message"), id: MessageId.or(Handle) }),
  z.strictObject({ kind: z.literal("event"), id: EventId.or(Handle) }),
  z.strictObject({ kind: z.literal("entity"), id: EntityId.or(Handle) }),
]);
export type ClientRef = z.infer<typeof ClientRef>;

const ADDRESS =
  /^[A-Za-z0-9!#$%&'*+/=?^_{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_{|}~-]+)*@([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]+$/;

// The one rule for an address a message may be sent to: the address in lower case, or null.
// ASCII only, nothing trimmed, at most 254 characters, a local part of at most 64 and domain
// labels of at most 63. The core's normalizeAddress parses what mail contains and is not this.
export function sendAddress(text: string): string | null {
  if (text.length > 254 || !ADDRESS.test(text)) return null;
  const at = text.lastIndexOf("@");
  if (at > 64) return null;
  if (
    text
      .slice(at + 1)
      .split(".")
      .some((label) => label.length > 63)
  )
    return null;
  return text.toLowerCase();
}

// Why the owner declined, one code from a closed list, so agents and lessons can tell
// a wrong idea from bad timing. Given only by the owner, with their answer (`pi decide --reason`, the
// web card's form), never by a model or an agent (invariant 5). Optional: a no with no reason still
// stands. Stored as the code of the status event the owner's no writes, plaintext; their free note
// stays sealed.
export const DeclineReason = z.enum([
  "not_worth_it",
  "wrong_timing",
  "already_handled",
  "wrong_person",
  "missing_context",
  "other",
]);
export type DeclineReason = z.infer<typeof DeclineReason>;

// A stored body's JSON value, or undefined for text that is not JSON. The caller parses the value
// with its schema next, so a body that is not JSON is refused as one of the wrong shape is.
export const jsonOf = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

// A stored JSON body parsed with its schema, or null for text that is not JSON or not the shape.
export function parseJsonBody<S extends z.ZodType>(schema: S, body: string): z.output<S> | null {
  const parsed = schema.safeParse(jsonOf(body));
  return parsed.success ? parsed.data : null;
}
