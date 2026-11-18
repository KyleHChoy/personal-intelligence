import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErasureId } from "@intelligence/contracts/personal";
import { expect, it } from "vitest";
import type { AdminContext } from "../../core/admin-context.ts";
import type { Query } from "../../core/db.ts";
import { appendJournal } from "../../core/journal.ts";
import { TRY_SYNC } from "../../core/locks.ts";
import { erasureLevel } from "./admin-erase-replay.ts";

it("an in-flight erasure refuses the owner check as busy, never as needing replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-erasure-level-"));
  const journal = join(dir, "erasures");
  try {
    await appendJournal(journal, {
      seq: 1,
      erasure: "ers_01JABCDEFGHJKMNPQRSTVWXYZ0" as ErasureId,
      kind: "item",
      items: [],
      suppress: [],
    });
    // The erasing session owns the lock and has flushed its journal, but not committed its mark.
    const query = (async (text: string) => (text === TRY_SYNC ? [{ held: false }] : [{ mark: "0" }])) as Query;
    const admin = { journal, transaction: (run: (q: Query) => Promise<unknown>) => run(query) } as AdminContext;
    await expect(erasureLevel(admin)).rejects.toMatchObject({ code: "sync_running" });
    const idleQuery = (async (text: string) => (text === TRY_SYNC ? [{ held: true }] : [{ mark: "0" }])) as Query;
    const idle = { ...admin, transaction: (run: (q: Query) => Promise<unknown>) => run(idleQuery) } as AdminContext;
    await expect(erasureLevel(idle)).resolves.toBe("behind");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
