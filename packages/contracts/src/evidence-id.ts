import { createHash } from "node:crypto";
import { z } from "zod";
import { EvidenceId, SourceAccountId, Vault } from "./ids.ts";

// Its own entry point, "@intelligence/contracts/evidence-id", so a browser bundle never loads it.

export const EvidenceIdInput = z.strictObject({
  vault: Vault,
  sourceAccount: SourceAccountId,
  sourceItemId: z.string().min(1),
  revision: z.number().int().nonnegative(),
});
export type EvidenceIdInput = z.infer<typeof EvidenceIdInput>;

// The one way an evidence id is made. The four fields are encoded as a JSON array in a fixed
// order, so no two inputs share an encoding.
export function evidenceIdFor(input: EvidenceIdInput): EvidenceId {
  const { vault, sourceAccount, sourceItemId, revision } = EvidenceIdInput.parse(input);
  const encoded = JSON.stringify([vault, sourceAccount, sourceItemId, revision]);
  return EvidenceId.parse(createHash("sha256").update(encoded, "utf8").digest("hex"));
}
