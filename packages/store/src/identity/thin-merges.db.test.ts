import type { Timestamp } from "@intelligence/contracts";
import { describe, expect, it, vi } from "vitest";
import { OWNER } from "../test-support/cast.ts";
import { session } from "../test-support/connections.ts";
import { type IdentityWorld, inIdentityWorld, req } from "../test-support/identity-fixtures.ts";
import { mail } from "../test-support/items.ts";
import { thinMerges } from "./thin-merges.ts";

// The joins that rest on little, as pi_admin. Made-up values on reserved domains.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const list = (world: IdentityWorld) => session(world.db.urls.admin, (query) => thinMerges(query, world.db.keys));
const from = async (world: IdentityWorld, address: string, name: string, n: number) => {
  await world.mail(
    mail({
      id: `gm-thin-${n}`,
      threadId: `thread-thin-${n}`,
      at: "2026-09-02T10:00:00Z" as Timestamp,
      from: { address, name },
      to: [{ address: OWNER.personal }],
      subject: "Hello",
      labels: ["INBOX"],
    }),
  );
  return world.person(address);
};
const link = (world: IdentityWorld, a: string, b: string) =>
  world.admin.identity.linkPeople(a as never, b as never, "same", { requestId: req() });

describe("thin merges", () => {
  it("lists a join on a first name alone, and on no shared name; never one on a full name or one contact, nor a lifted one", () =>
    inIdentityWorld(async (world) => {
      const [one, other] = [
        await from(world, "ione@thin-a.test", "Ione", 1),
        await from(world, "ione@thin-b.test", "Ione", 2),
      ];
      const firstName = await link(world, one, other);
      const [left, right] = [
        await from(world, "pat@thin-c.test", "Pat Vale", 3),
        await from(world, "patricia@thin-d.test", "Patricia", 4),
      ];
      const noName = await link(world, left, right);
      const [full, again] = [
        await from(world, "rhea.mott@thin-e.test", "Rhea Mott", 5),
        await from(world, "rm@thin-f.test", "Rhea Mott", 6),
      ];
      await link(world, full, again);
      await world.save(world.accounts.personalContacts, "both", {
        names: ["Sol"],
        emails: ["sol@thin-g.test", "sol@thin-h.test"],
      });
      await link(world, await world.person("sol@thin-g.test"), await world.person("sol@thin-h.test"));

      expect((await list(world)).map((row) => [row.ruling, row.reason, row.by])).toEqual([
        [firstName, "first_name_only", "owner"],
        [noName, "no_shared_name", "owner"],
      ]);
      await world.admin.identity.liftIdentity(firstName, { requestId: req() });
      expect((await list(world)).map((row) => row.ruling)).toEqual([noName]);
    }));
});
