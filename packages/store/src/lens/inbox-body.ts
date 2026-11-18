import { ownLabel } from "@intelligence/contracts/personal";
import { fingerprint } from "../core/fingerprint.ts";
import { sha256Hex } from "../core/ids.ts";
import type { Keys } from "../core/keys.ts";
import { open, type Sealed } from "../core/seal.ts";

// A row of the capture inbox opened under `own`, checked against its content fingerprint and parsed.
// One that will not open throws: what that means is the caller's, which may wait for its key or
// count the row failed. One whose content does not match or parse never will be an item.
export function readInbox(
  keys: Keys,
  row: { id: string; body_enc: Sealed | null; content_fp: string },
): { raw: unknown } | "content_mismatch" | "invalid_item" {
  const body = open(
    keys,
    { id: row.id, compartments: ownLabel(), body_enc: row.body_enc },
    "ledger.capture_inbox.body_enc",
    "throw",
  );
  if (fingerprint(keys, "content_hash", sha256Hex(body)) !== row.content_fp) return "content_mismatch";
  try {
    return { raw: JSON.parse(body) };
  } catch {
    return "invalid_item";
  }
}
