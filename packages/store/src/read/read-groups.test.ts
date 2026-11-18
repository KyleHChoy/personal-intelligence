import { describe, expect, it } from "vitest";
import type { Ctx } from "../core/read-ctx.ts";
import { loadGroups, RULINGS } from "./read-groups.ts";

// A call reads its groups once. A fake token whose statements answer
// no rows, counting each text it is sent. Made-up ids only.

const fake = (memo: boolean): { ctx: Ctx; sent: string[] } => {
  const sent: string[] = [];
  const ctx = {
    run: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
    keys: {},
    session: () => Promise.resolve("ses_test"),
    log: { info() {}, warn() {}, error() {} },
    ...(memo ? { groups: {} } : {}),
  } as unknown as Ctx;
  return { ctx, sent };
};

describe("loadGroups reads a call's groups once", () => {
  it("two reads on one call's Ctx send the rulings statement once, and the second answers the first's groups", async () => {
    const { ctx, sent } = fake(true);
    const [one, two] = [await loadGroups(ctx), await loadGroups(ctx)];
    expect(sent).toEqual([RULINGS]);
    expect(two).toBe(one);
  });

  it("the owner's read is kept apart from a client's", async () => {
    const { ctx, sent } = fake(true);
    await loadGroups(ctx);
    await loadGroups(ctx, { owner: true });
    await loadGroups(ctx, { owner: true });
    await loadGroups(ctx);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(RULINGS);
    expect(sent[1]).not.toBe(RULINGS);
  });

  it("a new call's Ctx reads again, and a Ctx without a memo reads each time", async () => {
    const first = fake(true);
    const second = fake(true);
    await loadGroups(first.ctx);
    await loadGroups(second.ctx);
    expect([first.sent, second.sent]).toEqual([[RULINGS], [RULINGS]]);
    const bare = fake(false);
    await loadGroups(bare.ctx);
    await loadGroups(bare.ctx);
    expect(bare.sent).toEqual([RULINGS, RULINGS]);
  });
});
