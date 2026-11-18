import { type EntityId, EntityView } from "@intelligence/contracts/personal";
import type { Person } from "@intelligence/personal-core/items";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, outcomeValue, registration } from "../test-support/values.ts";
import { type StoreSeeder, storeSeeder } from "../test-support/world.ts";

// Jo Example writes from an address on the owner's own mail domain, Lee Example from another; neither
// has a role or an affiliation. The page names each one's mail-domain organization as such, and its
// lead names no organization, since the lead's is the current role's or affiliation's alone. The
// synthetic world only.

const NOW = new Date("2026-03-10T12:00:00.000Z");
const OWNER = "owner.mail@example.org";
const jo: Required<Person> = { address: "jo@example.org", name: "Jo Example" };
const lee: Required<Person> = { address: "lee@quarry.example.net", name: "Lee Example" };

describe("a mail domain is no employer", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let seed: StoreSeeder;
  let token = "";

  beforeAll(async () => {
    store = await openStore({ compartments: ["own"], now: NOW });
    seed = storeSeeder(store.writer, NOW);
    const mail = await store.writer.ensureSourceAccount("personal", "google_mail", "own", OWNER);
    const owner: Person = { address: OWNER };
    await seed.mail(mail, { id: "d1", from: jo, to: [owner], at: daysFrom(NOW, -4), subject: "canary-d1" });
    await seed.mail(mail, { id: "d2", from: owner, to: [jo], at: daysFrom(NOW, -3), subject: "canary-d2", sent: true });
    await seed.mail(mail, { id: "d3", from: lee, to: [owner], at: daysFrom(NOW, -2), subject: "canary-d3" });
    ({ token } = await store.admin.clients.addClient(registration("mail-domain-client", ["own"])));
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store?.close();
  });

  const page = async (address: string) =>
    EntityView.parse(outcomeValue(await store.reader.getEntity(token, { id: seed.entityOf(address) as EntityId })));

  it("a shared mail domain is served as sharedMailDomain, and the lead names no organization", async () => {
    const view = await page(jo.address);
    // The control: the page still names the organization the address is on.
    expect(view.organization).toMatchObject({ kind: "organization", address: { untrusted: "example.org" } });
    expect(view.current?.role).toBeUndefined();
    expect(view.current?.affiliation).toBeUndefined();
    // Not a current organization: the lead's is the role's or the affiliation's alone.
    expect(view.lead?.organization).toBeNull();
    // How the owner knows them: both hold an address on the domain, named as a mail domain.
    expect(view.knownVia?.sharedMailDomain?.id).toBe(view.organization?.id);
    expect(view.knownVia).not.toHaveProperty("organization");
  });

  it("another mail domain is no shared one, and is no current organization either", async () => {
    const view = await page(lee.address);
    expect(view.organization).toMatchObject({ kind: "organization", address: { untrusted: "quarry.example.net" } });
    expect(view.lead?.organization).toBeNull();
    expect(view.knownVia?.sharedMailDomain).toBeNull();
  });
});
