import { describe, expect, it } from "vitest";
import { migratorOf, ownerMemberRefused } from "./roles.ts";

// Who may hold the owner: the bootstrap, and the migrator by one grant that sets and nothing more.

const grant = (
  member: string,
  options: { admin?: boolean; inherit?: boolean; set?: boolean; bootstrap?: boolean },
) => ({
  member,
  bootstrap: options.bootstrap ?? false,
  admin: options.admin ?? false,
  inherit: options.inherit ?? false,
  set: options.set ?? false,
});

describe("a membership in the owner", () => {
  const migrator = migratorOf();

  it("names the migrator by the run's prefix", () => {
    expect(migrator).toBe("pi_migrator");
    expect(migratorOf("t1_")).toBe("t1_migrator");
  });

  it("is allowed to the bootstrap, whose own options ensureRoles checks apart", () => {
    expect(ownerMemberRefused(grant("pi_bootstrap", { bootstrap: true, admin: true }), migrator)).toBe(false);
    expect(ownerMemberRefused(grant("pi_bootstrap", { bootstrap: true, set: true }), migrator)).toBe(false);
  });

  it("is allowed to the migrator only as a grant that sets, does not inherit and cannot grant on", () => {
    expect(ownerMemberRefused(grant(migrator, { set: true }), migrator)).toBe(false);
    for (const options of [
      { set: true, inherit: true },
      { set: true, admin: true },
      { set: false },
      { set: false, admin: true },
    ])
      expect(ownerMemberRefused(grant(migrator, options), migrator), JSON.stringify(options)).toBe(true);
  });

  it("is refused to every other role, a login role with the same grant among them", () => {
    expect(ownerMemberRefused(grant("pi_writer", { set: true }), migrator)).toBe(true);
    expect(ownerMemberRefused(grant("pi_migrator", { set: true }), migratorOf("t1_"))).toBe(true);
  });
});
