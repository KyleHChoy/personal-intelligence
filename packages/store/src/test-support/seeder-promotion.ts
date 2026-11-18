import type { Envelope } from "@intelligence/contracts";
import { sha256Hex, testId } from "./clients.ts";

type Insert = (table: string, row: Record<string, unknown>) => Promise<void>;
type Seal = (compartments: string[], table: string, id: string, column: string, value: string) => Envelope;

// A promotion taken from another instance, under the label given: ids, a provenance and a time. And
// a claim a taken promotion gave: its ids, ref, type and times in the clear, its statement sealed.
export const promotionSeeds = (insert: Insert, seal: Seal) => ({
  "ledger.promotions": async (compartments: string[]): Promise<string> => {
    const id = testId("prm");
    await insert("ledger.promotions", {
      id,
      direction: "in",
      provenance: sha256Hex(testId("prv")),
      claim_ids: [],
      created_at: new Date(),
      compartments,
    });
    return id;
  },
  "knowledge.promoted_claims": async (compartments: string[]): Promise<string> => {
    const id = sha256Hex(testId("prc"));
    await insert("knowledge.promoted_claims", {
      id,
      provenance: sha256Hex(testId("prv")),
      ref: "c1",
      type: "owner_note",
      subject_id: testId("ent"),
      subject_kind: "person",
      valid_from: new Date(),
      received_at: new Date(),
      content_enc: seal(
        compartments,
        "knowledge.promoted_claims",
        id,
        "content_enc",
        JSON.stringify({ statement: { text: "seed promoted words" } }),
      ),
      readers: ["owner"],
      compartments,
    });
    return id;
  },
});
