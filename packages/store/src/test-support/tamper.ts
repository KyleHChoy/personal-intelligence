import { session } from "./connections.ts";
import type { TestDatabase } from "./database.ts";

// Committed for the whole test database, so never beside another test of it.
const TABLES = ["vault.evidence_items", "vault.evidence_blobs"];

export async function tampering<T>(db: TestDatabase, write: () => Promise<T>): Promise<T> {
  const turn = (word: "disable" | "enable"): Promise<void> =>
    session(db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      for (const table of TABLES) await query(`alter table ${table} ${word} trigger evidence_content_fixed`);
    });
  await turn("disable");
  try {
    return await write();
  } finally {
    await turn("enable");
  }
}
