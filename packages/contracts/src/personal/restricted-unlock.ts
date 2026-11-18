import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { RESTRICTED_PREFIX, RestrictedCategory } from "./compartments.ts";

// Passkey-unlocked restricted compartments. The one place that names the restricted set: session
// taint and every other reader of "is this restricted" take it from here.

// Every restricted compartment, one for each category. A row whose label holds one is restricted.
export const RESTRICTED_COMPARTMENTS: readonly string[] = Object.freeze(
  RestrictedCategory.options.map((category) => `${RESTRICTED_PREFIX}${category}`),
);

// The categories whose keys `pia keys restricted-init` makes and wraps: health, money and legal. A
// restricted key file that is wrapped holds only these, so every one of them opens only after an
// unlock.
export const PASSKEY_CATEGORIES: readonly RestrictedCategory[] = Object.freeze(["health", "money", "legal"]);

// The refusal a read or a write meets when it needs a restricted key that is locked.
export const RESTRICTED_LOCKED = "restricted_locked";

// How long an unlock holds the restricted keys in memory before they are forgotten.
export const UNLOCK_WINDOW_MS = 30 * 60_000;

const b64url = (max: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(max);

// What the dashboard posts to unlock: the passkey's assertion over the server's challenge, with the
// passkey's PRF output for the file's salt. `recovery`, the owner's recovery secret, unlocks when the
// passkey has no PRF slot yet (and gives it one) or gives no PRF output at all.
export const RestrictedUnlockPost = z.strictObject({
  id: b64url(1024),
  clientDataJSON: b64url(4096),
  authenticatorData: b64url(4096),
  signature: b64url(1024),
  prf: b64url(64).optional(),
  recovery: b64url(64).optional(),
});
export type RestrictedUnlockPost = z.infer<typeof RestrictedUnlockPost>;

// Whether the restricted keys are open in the dashboard's process now: `none` when no wrapped file
// is set up, and the time they lock again when open.
export const RestrictedLockState = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("none") }),
  z.strictObject({ state: z.literal("locked"), passkey: z.boolean() }),
  z.strictObject({ state: z.literal("unlocked"), until: Timestamp }),
]);
export type RestrictedLockState = z.infer<typeof RestrictedLockState>;
