import { z } from "zod";

// The field forms the owner's shapes share (owner.ts and its siblings). Not on the package root.
// A word in code: lower case letters, digits and underscores, at most 32 characters. The
// database checks every kind column for this form only, so later items add values with no
// migration.
export const word = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
export const days = z.number().int().min(1).nullable();
export const count = z.number().int().nonnegative();
