import { describe, expect, it, vi } from "vitest";
import type { Query } from "../core/db.ts";
import type { Db } from "../core/job-db.ts";
import type { Tx } from "../core/tx.ts";
import { createWriter } from "./writer.ts";

const state = vi.hoisted(() => ({ lost: false, statements: [] as string[], mode: "transaction" }));
vi.mock("../core/job-db.ts", () => ({
  createDb: (): Db => {
    const query: Query = async <Row>(sql: string) => {
      state.statements.push(sql);
      if (sql === "first") state.lost = true;
      return [] as Row[];
    };
    return {
      query,
      transaction: (fn) => fn(query),
      session: (fn) => fn((async () => [{ held: true }]) as Query, () => state.lost),
      close: async () => {},
    };
  },
}));
vi.mock("../lens/chat-lines.ts", () => ({
  backfillChatLines: async (writer: { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>; direct: Tx }) => {
    if (state.mode === "direct") {
      await writer.direct.query("first");
      await writer.direct.query("second");
    } else {
      await writer.transaction(async (tx) => {
        await tx.query("first");
      });
      await writer.transaction(async (tx) => {
        await tx.query("second");
      });
    }
    return {};
  },
}));

describe("a writer pass that loses its sync lock", () => {
  it.each(["transaction", "direct"])("refuses the later %s write", async (mode) => {
    state.lost = false;
    state.statements = [];
    state.mode = mode;
    const writer = createWriter({
      url: "postgresql://localhost/test",
      keys: { compartments: new Map(), fingerprintKey: Buffer.alloc(32) },
      log: { info() {}, warn() {}, error() {} },
    });
    await expect(writer.withSyncLock(() => writer.backfillChatLines({ dryRun: false }))).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(state.statements).toEqual(["first"]);
    await writer.close();
  });

  it("still reads", async () => {
    state.lost = false;
    state.statements = [];
    state.mode = "direct";
    const writer = createWriter({
      url: "postgresql://localhost/test",
      keys: { compartments: new Map(), fingerprintKey: Buffer.alloc(32) },
      log: { info() {}, warn() {}, error() {} },
    });
    let read: unknown;
    await expect(
      writer.withSyncLock(async () => {
        await writer.backfillChatLines({ dryRun: false }).catch(() => {});
        read = await writer.ownerAddresses();
        return "synced";
      }),
    ).resolves.toBe("synced");
    expect(read).toEqual([]);
    expect(state.statements).toHaveLength(2);
    await writer.close();
  });
});
