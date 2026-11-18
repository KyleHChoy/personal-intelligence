import { CONTACT_CLAIMS_V1, CONTACT_CLAIMS_V2 } from "@intelligence/personal-core/items";
import { describe, expect, it, vi } from "vitest";
import { inIdentityWorld } from "../test-support/identity-fixtures.ts";

// A dry run counts and writes nothing; at the version they were made at, nothing changes; at a
// later version, each contact's claims of contact-claims@1 are made again with their version 1 key
// beside the new one, the old ones removed with the beliefs they support. At contact-claims@3 the
// claims its rules no longer make are removed. Made-up values on reserved domains.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const MAREN = "maren@reclaim.test";

describe("contacts reclaim", () => {
  it("a dry run counts and changes nothing; the run re-keys contact-claims@1's claims at the version in force; a second run finds nothing to do", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "maren", {
        names: ["Maren Holt"],
        emails: [MAREN],
        organization: "Example Works Holdings",
        title: "Head of Research",
      });
      const claims = () =>
        world.sql<{ id: string; type: string; fact_key_fp: string; legacy_fact_key_fp: string | null }>(
          "select c.id, c.type, c.fact_key_fp, c.legacy_fact_key_fp from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id where e.source_kind = 'crm' order by c.type, c.id",
        );
      const saved = await claims();
      expect(saved.map((one) => one.type)).toEqual(["affiliation", "role"]);

      // At the version in force: nothing to do.
      expect(await world.store.writer.reclaimContacts({ dryRun: false })).toEqual({
        contacts: 1,
        changed: 0,
        removed: 0,
        written: 0,
      });
      expect(await claims()).toEqual(saved);

      // The claims as stored before the go: made again at contact-claims@1, with no version 1 key beside them.
      expect(await world.store.writer.reclaimContacts({ dryRun: false, version: CONTACT_CLAIMS_V1 })).toEqual({
        contacts: 1,
        changed: 1,
        removed: 2,
        written: 2,
      });
      const before = await claims();
      expect(before.map((one) => one.legacy_fact_key_fp)).toEqual([null, null]);

      // A dry run at the version in force counts both claims and writes nothing.
      expect(await world.store.writer.reclaimContacts({ dryRun: true })).toEqual({
        contacts: 1,
        changed: 1,
        removed: 2,
        written: 2,
      });
      expect(await claims()).toEqual(before);

      // The run: new ids; the role's key now holds its title, with its version 1 key beside it.
      expect(await world.store.writer.reclaimContacts({ dryRun: false })).toEqual({
        contacts: 1,
        changed: 1,
        removed: 2,
        written: 2,
      });
      const after = await claims();
      expect(after.map((one) => one.type)).toEqual(["affiliation", "role"]);
      expect(after.some((one) => before.some((old) => old.id === one.id))).toBe(false);
      const [oldRole, newRole] = [before.find((one) => one.type === "role"), after.find((one) => one.type === "role")];
      expect(newRole?.fact_key_fp).not.toBe(oldRole?.fact_key_fp);
      expect(newRole?.legacy_fact_key_fp).toBe(oldRole?.fact_key_fp);
      // An affiliation's key is the same at both versions.
      expect(after.find((one) => one.type === "affiliation")?.fact_key_fp).toBe(
        before.find((one) => one.type === "affiliation")?.fact_key_fp,
      );
      expect(await world.count("knowledge.claim_entities", "claim_id = any ($1)", [after.map((one) => one.id)])).toBe(
        2,
      );

      expect(await world.store.writer.reclaimContacts({ dryRun: false })).toEqual({
        contacts: 1,
        changed: 0,
        removed: 0,
        written: 0,
      });
    }));

  // A domain employer, an affiliation from the contact's own email domain, is no
  // claim at contact-claims@3; a good one is made again on its own key. An owner's ruling on the
  // removed fact stays, and `pia extract carry-over` lists it as finding no claim.
  it("at contact-claims@3 a reclaim removes a domain employer's affiliation and role and keeps a good one, as backfill; a ruling on the removed fact is listed by the carry-over check", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "maren", {
        names: ["Maren Holt"],
        emails: [MAREN],
        organization: "Example Works Holdings",
        title: "Head of Research",
      });
      await world.save(world.accounts.personalContacts, "ines", {
        names: ["Ines Vale"],
        emails: ["ines@mail.lumen-reclaim.test"],
        organization: "lumen-reclaim.test",
        title: "Analyst",
      });
      const claims = (address: string) =>
        world.sql<{ id: string; type: string; fact_key_fp: string }>(
          "select c.id, c.type, c.fact_key_fp from knowledge.claims c join knowledge.claim_entities ce on ce.claim_id = c.id join knowledge.accounts a on a.entity_id = ce.entity_id where a.value_fp = $1 order by c.type, c.id",
          [world.fp(address)],
        );
      // Written under the contact quality rules: the domain employer makes nothing.
      expect((await claims(MAREN)).map((one) => one.type)).toEqual(["affiliation", "role"]);
      expect(await claims("ines@mail.lumen-reclaim.test")).toEqual([]);

      // The claims contact-claims@2 makes, made again at that version.
      expect(await world.store.writer.reclaimContacts({ dryRun: false, version: CONTACT_CLAIMS_V2 })).toEqual({
        contacts: 2,
        changed: 2,
        removed: 2,
        written: 4,
      });
      const good = await claims(MAREN);
      const bad = await claims("ines@mail.lumen-reclaim.test");
      expect(bad.map((one) => one.type)).toEqual(["affiliation", "role"]);
      // The owner ruled on the domain employer's affiliation.
      const affiliation = bad.find((one) => one.type === "affiliation");
      const ruling = `rul_${"7".repeat(26)}`;
      await world.sql(
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, decided_at, compartments) values ($1, $2, 'fact_veto', 0, now(), '{own}')",
        [ruling, "req-reclaim-0171"],
      );
      await world.sql(
        "insert into knowledge.belief_rulings (ruling_id, verdict, claim_fp, fact_key_fp, created_at, compartments) values ($1, 'veto', $2, $3, now(), '{own}')",
        [ruling, affiliation?.id, affiliation?.fact_key_fp],
      );
      expect((await world.admin.extraction.carryOver({ generation: 0 })).rulings.unfound).not.toContain(ruling);

      // A dry run counts the two removed and the two re-made, and writes nothing.
      expect(await world.store.writer.reclaimContacts({ dryRun: true })).toEqual({
        contacts: 2,
        changed: 2,
        removed: 4,
        written: 2,
      });
      expect(await claims("ines@mail.lumen-reclaim.test")).toEqual(bad);

      await world.sql("delete from ledger.trigger_rechecks");
      expect(await world.store.writer.reclaimContacts({ dryRun: false })).toEqual({
        contacts: 2,
        changed: 2,
        removed: 4,
        written: 2,
      });
      expect(await claims("ines@mail.lumen-reclaim.test")).toEqual([]);
      const kept = await claims(MAREN);
      expect(kept.map((one) => [one.type, one.fact_key_fp])).toEqual(good.map((one) => [one.type, one.fact_key_fp]));
      expect(kept.some((one) => good.some((old) => old.id === one.id))).toBe(false);
      // Its rechecks are backfill, so the reclaim raises nothing.
      const causes = await world.sql<{ cause: string }>("select distinct cause from ledger.trigger_rechecks");
      expect(causes.map((one) => one.cause)).toEqual(["backfill"]);
      // The ruling stays, and finds no claim: the carry-over check lists it for the owner.
      expect(await world.count("knowledge.belief_rulings", "ruling_id = $1", [ruling])).toBe(1);
      expect((await world.admin.extraction.carryOver({ generation: 0 })).rulings.unfound).toContain(ruling);

      expect(await world.store.writer.reclaimContacts({ dryRun: false })).toEqual({
        contacts: 2,
        changed: 0,
        removed: 0,
        written: 0,
      });
    }));
});
