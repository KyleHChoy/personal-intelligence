import { describe, expect, it } from "vitest";
import { readJournal } from "../../core/journal.ts";
import { type IdentityWorld, inIdentityWorld, req } from "../../test-support/identity-fixtures.ts";
import { createAdmin } from "../admin.ts";

// Erasure and the group. Made-up values only.

const TIMEOUT = 180_000;
const SAM = ["sam@identity-erase.test", "sam.orrin@identity-erase.example"];

async function samJoined(world: IdentityWorld): Promise<string> {
  await world.save(world.accounts.personalContacts, "sam", { names: ["Sam Orrin"], emails: SAM });
  return world.admin.identity.linkPeople(await world.person(SAM[0] ?? ""), await world.person(SAM[1] ?? ""), "same", {
    requestId: req(),
  });
}

describe("erasure and the group", { timeout: TIMEOUT }, () => {
  it("erasing one member erases the group, its contacts, a two-address contact included, and its rulings; the hook's count is in ErasureReport.more", () =>
    inIdentityWorld(async (world) => {
      await samJoined(world);
      await world.save(world.accounts.personalContacts, "orrin-only", { names: ["S. Orrin"], emails: [SAM[1] ?? ""] });
      const report = await world.admin.erasure.erasePerson(await world.person(SAM[0] ?? ""), { requestId: req() });
      expect(report.more.identity).toBe(1);
      expect(report.suppressed).toBe(2);
      expect(await world.count("knowledge.contacts")).toBe(0);
      expect(await world.count("knowledge.identity_rulings")).toBe(0);
      expect(await world.count("knowledge.accounts", "value_fp = any($1)", [SAM.map(world.fp)])).toBe(0);
      expect(await world.count("knowledge.owner_decisions", "kind = 'identity'")).toBe(1);
    }));

  it("a dry run counts every member and the hook's rows, and writes nothing", () =>
    inIdentityWorld(async (world) => {
      await samJoined(world);
      const dry = await world.admin.erasure.erasePerson(await world.person(SAM[0] ?? ""), {
        requestId: req(),
        dryRun: true,
      });
      expect(dry).toMatchObject({ erasure: null, suppressed: 2, items: 1, more: { identity: 1 } });
      expect(await world.count("knowledge.identity_rulings")).toBe(1);
      expect(await world.count("knowledge.contacts")).toBe(1);
    }));

  it("Q12: the other addresses of an erased contact are not suppressed", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "two", {
        names: ["Two People"],
        emails: ["erased@identity-erase.test", "kept@identity-erase.test"],
      });
      await world.admin.erasure.erasePerson(await world.person("erased@identity-erase.test"), { requestId: req() });
      expect(await world.count("knowledge.suppressions", "value_fp = $1", [world.fp("kept@identity-erase.test")])).toBe(
        0,
      );
      expect(
        await world.count("knowledge.suppressions", "value_fp = $1", [world.fp("erased@identity-erase.test")]),
      ).toBe(1);
    }));

  it("a stored 25-address contact whose 22nd address is erased is removed", () =>
    inIdentityWorld(async (world) => {
      const emails = Array.from({ length: 25 }, (_, i) => `p${i}@identity-erase.test`);
      await world.save(world.accounts.personalContacts, "big", { names: ["Many"], emails });
      await world.save(world.accounts.personalContacts, "p21", { names: ["Twenty Two"], emails: [emails[21] ?? ""] });
      await world.admin.erasure.erasePerson(await world.person(emails[21] ?? ""), { requestId: req() });
      expect(await world.count("knowledge.contacts")).toBe(0); // erasure-proves: knowledge.contacts.evidence_id
    }));

  it("a ruling lifted before the erasure joins nothing: the journal entry replay reads names only the erased person's fingerprint, and the other person is untouched", () =>
    inIdentityWorld(async (world) => {
      const ruling = await samJoined(world);
      // The other address is on a contact of its own too: the two-address contact goes with the
      // erasure (D28), and the person stays through this one.
      await world.save(world.accounts.personalContacts, "orrin-only", { names: ["S. Orrin"], emails: [SAM[1] ?? ""] });
      await world.admin.identity.liftIdentity(ruling as never, { requestId: req() });
      const other = await world.person(SAM[1] ?? "");
      await world.admin.erasure.erasePerson(await world.person(SAM[0] ?? ""), { requestId: req() });
      // Replay takes the entry's items and fingerprints as written (targetOf), never the
      // group again, so a restored database whose lift was lost suppresses only these.
      const journal = await readJournal(world.journal);
      const entries = journal.entries.filter((entry) => "erasure" in entry);
      expect(entries.map((entry) => ("suppress" in entry ? entry.suppress : []))).toEqual([[world.fp(SAM[0] ?? "")]]);
      expect(await world.person(SAM[1] ?? "")).toBe(other);
      expect(await world.count("knowledge.suppressions", "value_fp = $1", [world.fp(SAM[1] ?? "")])).toBe(0);
    }));

  it("link racing an erasure: a link and an erasure of one of its people, on two connections in both orders, end with no ruling that holds the erased fingerprint", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "sam", { names: ["Sam Orrin"], emails: SAM });
      const [sam, orrin] = [await world.person(SAM[0] ?? ""), await world.person(SAM[1] ?? "")];
      const other = createAdmin({
        url: world.db.urls.admin,
        keys: world.db.keys,
        log: world.store.log,
        journal: world.journal,
      });
      try {
        await Promise.allSettled([
          other.identity.linkPeople(sam, orrin, "same", { requestId: req() }),
          world.admin.erasure.erasePerson(sam, { requestId: req() }),
        ]);
      } finally {
        await other.close();
      }
      expect(await world.count("knowledge.identity_rulings", "a_fp = $1 or b_fp = $1", [world.fp(SAM[0] ?? "")])).toBe(
        0,
      );
    }));
});
