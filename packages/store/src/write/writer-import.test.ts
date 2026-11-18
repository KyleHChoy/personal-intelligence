import { describe, expect, it } from "vitest";
import type { Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";
import { previewImport } from "./writer-import.ts";

// Contact import's dry run: it reads in a read-only transaction, and answers an erased item as the
// writer does, before its suppressed address. Against a stand-in query that answers by statement.

const keys: Keys = { compartments: new Map(), fingerprintKey: Buffer.alloc(32, 7) };
const ITEM = "contact:import:erased-row";
const ADDRESS = "erased@preview-import.test";

function stand(): { query: Query; texts: string[] } {
  const texts: string[] = [];
  const answer = (text: string): unknown[] => {
    if (text.includes("from vault.source_accounts")) return [{ id: "acc_import" }];
    if (text.includes("from vault.evidence_items")) return [];
    if (text.includes("from knowledge.removed_evidence"))
      return [{ source_item_fp: fingerprint(keys, "source_id", ITEM) }];
    if (text.includes("from knowledge.suppressions")) return [{ value_fp: fingerprint(keys, "address", ADDRESS) }];
    if (text.includes("from ledger.cards")) return [{ n: 3 }];
    return [];
  };
  const query = (async (text: string) => {
    texts.push(text);
    return answer(text);
  }) as Query;
  return { query, texts };
}

describe("previewImport", () => {
  it("runs read-only, its first statement before any read", async () => {
    const { query, texts } = stand();
    await previewImport({ query, keys }, "sheet", []);
    expect(texts[0]).toBe("set transaction read only");
  });

  it("counts an erased item as erased, as the writer answers it, though its address is suppressed too; and the sweep's room", async () => {
    const { query } = stand();
    const preview = await previewImport({ query, keys }, "sheet", [
      { sourceItemId: ITEM, revisionTag: "c:1", addresses: [ADDRESS] },
    ]);
    expect(preview.items).toEqual({ new: 0, changed: 0, unchanged: 0, removed: 0, erased: 1, suppressed: 0 });
    expect(preview.identity).toEqual({ open: 3, cap: 10, room: 7 });
  });
});
