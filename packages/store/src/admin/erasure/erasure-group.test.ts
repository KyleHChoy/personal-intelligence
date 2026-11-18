import type { EntityId, ErasureId, FactId, GoalId, MessageId } from "@intelligence/contracts/personal";
import { describe, expect, it, vi } from "vitest";
import type { AdminContext } from "../../core/admin-context.ts";
import { lensAdmin } from "../lens/lens-group.ts";
import { erasureAdmin } from "./erasure-group.ts";

// Invariant 10: every erasure through an Admin drops its in-memory indexes at once, whether or not
// anyone searches again, and whether or not the erasure got through. The database is never reached.

type Fake = { context: AdminContext; dropNames: <T>(erasure: Promise<T>) => Promise<T> };
const fakeCore = (): Fake =>
  ({
    context: {
      transaction: () => Promise.reject(new Error("stopped")),
      keys: { compartments: new Map() },
      log: { info() {}, warn() {}, error() {} },
      now: () => new Date(),
      journal: "/nonexistent/keys.json.erasures",
    },
    dropNames: vi.fn(async (erasure: Promise<unknown>) => erasure),
  }) as unknown as Fake;

const options = { requestId: "req" };

describe("every erasure drops the name and item indexes", () => {
  const erasures: [string, (core: Fake) => Promise<unknown>][] = [
    [
      "eraseItem",
      (core) =>
        erasureAdmin(core.context, core.dropNames).eraseItem({ kind: "message", id: "msg" as MessageId }, options),
    ],
    ["erasePerson", (core) => erasureAdmin(core.context, core.dropNames).erasePerson("ent" as EntityId, options)],
    ["eraseGoal", (core) => erasureAdmin(core.context, core.dropNames).eraseGoal("gol" as GoalId, options)],
    ["eraseOwnerItem", (core) => erasureAdmin(core.context, core.dropNames).eraseOwnerItem("fct" as FactId, options)],
    ["replayErasures", (core) => erasureAdmin(core.context, core.dropNames).replayErasures()],
    ["settleForgets", (core) => lensAdmin(core.context, core.dropNames).settleForgets()],
  ];
  for (const [name, run] of erasures)
    it(name, async () => {
      const core = fakeCore();
      await run(core).catch(() => {});
      expect(core.dropNames).toHaveBeenCalledTimes(1);
    });

  it("a lift erases nothing, so it drops nothing", async () => {
    const core = fakeCore();
    await erasureAdmin(core.context, core.dropNames)
      .liftErasure("ers" as ErasureId, options)
      .catch(() => {});
    expect(core.dropNames).not.toHaveBeenCalled();
  });
});
