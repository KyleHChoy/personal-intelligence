import { z } from "zod";
import { EvidenceId, KeyRef } from "./ids.ts";

// One data key as it travels in a key service reply: base64 of 32 bytes. Never logged, never stored.
export const DataKey = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/)
  .brand<"DataKey">();
export type DataKey = z.infer<typeof DataKey>;

// Sealed content. Each part is base64.
export const Envelope = z.strictObject({
  v: z.literal(1),
  nonce: z.base64().min(1),
  ciphertext: z.base64(),
  tag: z.base64().min(1),
});
export type Envelope = z.infer<typeof Envelope>;

// What sealed content is bound to. Opening it under another binding fails.
export const CipherBinding = z.object({ evidenceId: EvidenceId, field: z.string().min(1) });
export type CipherBinding = z.infer<typeof CipherBinding>;

// The keys this content needs: one per evidence item it was derived from, sorted by evidence id,
// no repeats. Content derived from several items is sealed under a key derived from all of them,
// and opening it needs every one released, each against its own item's label.
export const ContentKeys = z
  .array(z.object({ evidenceId: EvidenceId, keyRef: KeyRef }))
  .min(1)
  .refine(
    (keys) => keys.every((key, index) => index === 0 || String(keys[index - 1]?.evidenceId) < String(key.evidenceId)),
    {
      message: "not sorted by evidence id, or an evidence id repeats",
    },
  );
export type ContentKeys = z.infer<typeof ContentKeys>;
