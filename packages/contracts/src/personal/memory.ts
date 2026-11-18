import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { EntityId, RequestId } from "./ids.ts";
import { Hex64 } from "./primitives.ts";

// The outbound memory adapter: what a client's own memory file is given. Typed values and stamps
// only: no field holds a word from any source.

// A keyed Hex64 of the client, the fact key, the entry's visible values and the template,
// made by the store. It changes exactly when what the entry shows changes.
export const MemoryProjectionId = z
  .string()
  .regex(/^mpr_[0-9a-f]{40}$/)
  .brand<"MemoryProjectionId">();
export type MemoryProjectionId = z.infer<typeof MemoryProjectionId>;

// `fact` and `state` are the belief's fact key and state fingerprints as last served. No
// version: a belief's version is served to no client.
export const MemoryStamp = z.strictObject({ projection: MemoryProjectionId, fact: Hex64, state: Hex64 });
export type MemoryStamp = z.infer<typeof MemoryStamp>;

export const MemorySection = z.enum(["commitments"]);
export type MemorySection = z.infer<typeof MemorySection>;

export const MemoryEntry = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("commitment"),
    section: z.literal("commitments"),
    stamp: MemoryStamp,
    status: z.enum(["active", "stale"]),
    direction: z.enum(["owed_by_owner", "owed_to_owner"]),
    counterparty: EntityId.nullable(),
    due: z.union([DateOnly, Timestamp]).nullable(),
  }),
]);
export type MemoryEntry = z.infer<typeof MemoryEntry>;

// `changed`: what the entry showed changed, and `current` names the entry now. `withdrawn`: the
// belief is gone for this client, or a deletion tainted it. `dropped`: still open, cut by the cap.
export const MemoryCorrection = z
  .strictObject({
    projection: MemoryProjectionId,
    endedAt: Timestamp,
    reason: z.enum(["changed", "withdrawn", "dropped"]),
    current: MemoryProjectionId.nullable(),
  })
  .refine((correction) => (correction.reason === "changed") === (correction.current !== null), {
    message: "current is set exactly when the reason is changed",
    path: ["current"],
  });
export type MemoryCorrection = z.infer<typeof MemoryCorrection>;

export const MemoryProjection = z.strictObject({
  template: z.string().regex(/^[a-z_]+@[1-9][0-9]*$/),
  asOf: Timestamp.nullable(),
  entries: z.array(MemoryEntry),
  corrections: z.array(MemoryCorrection).max(20),
  remove: z.array(MemoryProjectionId),
  truncated: z.boolean(),
  inStep: z.boolean(),
  hash: Hex64,
});
export type MemoryProjection = z.infer<typeof MemoryProjection>;

// `have` is every projection id stamped in the file the adapter owns.
export const SyncMemoryArgs = z.strictObject({
  have: z
    .array(MemoryProjectionId)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, { message: "an id twice" }),
  canDelete: z.boolean(),
});
export type SyncMemoryArgs = z.infer<typeof SyncMemoryArgs>;

// Inbound: the changes an agent made to its own memory, as the adapter sends them with import_memory.
// `locator` is the listed directory, the file and the adapter's entry id; the host keeps it only as a keyed
// Hex64. Refined: a body exactly when added.
const codePoints = (text: string): number => [...text].length;
const text = (most: number) =>
  z
    .string()
    .refine((value) => codePoints(value) >= 1 && codePoints(value) <= most, { message: `1 to ${most} code points` })
    .refine((value) => !value.includes("\u0000"), { message: "a NUL" });

export const MemoryChange = z
  .strictObject({
    requestId: RequestId,
    locator: text(512),
    change: z.enum(["added", "removed"]),
    entryTime: Timestamp.optional(),
    body: text(8000).optional(),
  })
  .refine((change) => (change.body !== undefined) === (change.change === "added"), {
    message: "a body exactly when added",
  });
export type MemoryChange = z.infer<typeof MemoryChange>;

export const ImportMemoryArgs = z.strictObject({ changes: z.array(MemoryChange).min(1).max(50) });
export type ImportMemoryArgs = z.infer<typeof ImportMemoryArgs>;

// The number of changes in the call, whatever happened to each.
export const ImportMemoryAck = z.strictObject({ received: z.number().int().nonnegative() });
export type ImportMemoryAck = z.infer<typeof ImportMemoryAck>;
