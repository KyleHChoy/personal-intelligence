import { z } from "zod";

// The field forms and paging the owner's reads share (owner-reads.ts and its siblings). The paging
// names are on the package root, through the index; the field forms are not.

export const count = z.number().int().nonnegative();
export const minutes = z.number().min(0);
export const usd = z.number().min(0);
export const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
// Read arguments arrive in a path or query string, so each value is parsed from its text: a number
// from digits, a boolean from `true` or `false`, a list from comma-separated words.
export const queryInt = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
export const queryBool = z.stringbool({ truthy: ["true"], falsy: ["false"] });

// Every list read pages. The cursor is the server's, opaque, base64url; `next` is null when no more
// exist.
export const OWNER_PAGE_DEFAULT = 50;
export const OWNER_PAGE_MOST = 200;
export const OwnerCursor = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export type OwnerCursor = z.infer<typeof OwnerCursor>;
export const OwnerPageArgs = z.strictObject({
  cursor: OwnerCursor.optional(),
  limit: queryInt(1, OWNER_PAGE_MOST).optional(),
});
export type OwnerPageArgs = z.infer<typeof OwnerPageArgs>;
export const next = OwnerCursor.nullable();
