import { describe, expect, it } from "vitest";
import { decide } from "../admin/cards/admin-queue.ts";
import type { AdminContext } from "../core/admin-context.ts";
import { AdminError } from "../core/admin-error.ts";
import type { Keys } from "../core/keys.ts";

// The learning item's store refusals for what is not yet built, before any statement.

describe("the learning item not yet built", () => {
  it("decide refuses an expectation with not_built until R16 is built", async () => {
    let opened = 0;
    const context = {
      transaction: async () => {
        opened += 1;
        throw new Error("no transaction");
      },
      keys: {} as Keys,
      now: () => new Date(),
    } as unknown as AdminContext;
    const args = {
      cards: ["crd_01JABCDEFGHJKMNPQRSTVWXYZ0" as never],
      answer: "go",
      expect: 0.4,
      requestId: "req-0001",
    };
    await expect(decide(context, args)).rejects.toEqual(new AdminError("not_built"));
    await expect(decide(context, args)).rejects.toMatchObject({ code: "not_built" });
    expect(opened).toBe(0);
    // The control: the same call with no expectation reaches its transaction.
    const { expect: _expect, ...plain } = args;
    await expect(decide(context, plain)).rejects.toThrow("no transaction");
    expect(opened).toBe(1);
  });
});
