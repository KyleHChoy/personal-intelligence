import type { ErasureHook } from "./erasure-hook.ts";

// In the erasure's transaction, after the removal: the owner's fingerprint and sealed value go from
// every document the person owns, and the sharer's from every one they shared. The count is of the
// rows changed, or under a dry run of the rows it would change. A replay runs it again.
export const DOCUMENTS_HOOK: ErasureHook = {
  name: "documents",
  async run(query, erased, { dryRun }) {
    if (erased.addressFps.length === 0) return 0;
    if (dryRun) {
      const [row] = await query<{ n: number }>(
        "select count(*)::int as n from knowledge.documents where owner_fp = any($1) or sharer_fp = any($1)",
        [erased.addressFps],
      );
      return row?.n ?? 0;
    }
    const changed = await query<{ id: string }>(
      `update knowledge.documents set
         owner_fp = case when owner_fp = any($1) then null else owner_fp end,
         owner_enc = case when owner_fp = any($1) then null else owner_enc end,
         sharer_fp = case when sharer_fp = any($1) then null else sharer_fp end,
         sharer_enc = case when sharer_fp = any($1) then null else sharer_enc end
       where owner_fp = any($1) or sharer_fp = any($1) returning id`,
      [erased.addressFps],
    );
    return changed.length;
  },
};
