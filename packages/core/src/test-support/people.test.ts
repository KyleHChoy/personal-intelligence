import type { SourceAccount } from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { contactItem, whitelistedContact } from "../items/contacts.ts";
import { fakeContacts, fakeSources, world } from "../testing.ts";

// n1.4: the fake People source hands over the pages the People connector would.
const sourceAccount = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
const account: SourceAccount = {
  id: sourceAccount,
  connector: "google_contacts",
  sourceKind: "crm",
  vault: "personal",
  externalRef: "owner@example.org",
  accessSyncKind: "none",
  compartments: ["own"],
  markerCompartments: [],
};
const now = "2026-03-10T12:00:00.000Z";
const own = { metadata: { source: { type: "CONTACT", id: "c" } } };
const person = (n: number, name = `Person ${n}`) => ({
  resourceName: `people/c${n}`,
  metadata: { sources: [{ type: "CONTACT", id: `c${n}`, updateTime: "2026-02-01T09:00:00Z" }] },
  names: [{ ...own, displayName: name }],
  emailAddresses: [{ ...own, value: `p${n}@example.org` }],
});
const ids = (page: { items: { sourceItemId: string }[] }) => page.items.map((one) => one.sourceItemId);

describe("fakeContacts", () => {
  it("the fake hands over a listing, then changes after its token, then a new listing after an expiry", async () => {
    const fake = fakeContacts([person(1), person(2), person(3)], { now, pageSize: 2 });
    const connector = fake.connector(sourceAccount);
    const first = await connector.listChanges(account, null, 10);
    expect([ids(first), first.listing, first.more]).toEqual([
      ["contact:people/c1", "contact:people/c2"],
      { first: true },
      true,
    ]);
    const last = await connector.listChanges(account, first.next, 10);
    expect([ids(last), last.listing, last.more]).toEqual([
      ["contact:people/c3"],
      { first: false, ended: "complete" },
      false,
    ]);

    fake.upsert(person(2, "Renamed"));
    fake.remove("people/c3");
    const changes = await connector.listChanges(account, last.next, 10);
    expect(changes.listing).toBeUndefined();
    expect(ids(changes)).toEqual(["contact:people/c2"]);
    expect(changes.items[0]?.changeKind).toBe("live");
    expect(changes.deletions.map((one) => one.sourceItemId)).toEqual(["contact:people/c3"]);
    const read = whitelistedContact(person(2, "Renamed"));
    expect(changes.items[0]).toEqual(contactItem(read!, { sourceAccount, changeKind: "live", now }));
    const quiet = await connector.listChanges(account, changes.next, 10);
    expect([ids(quiet), quiet.deletions]).toEqual([[], []]);

    fake.expireSyncTokens();
    const fresh = await connector.listChanges(account, quiet.next, 10);
    expect([ids(fresh), fresh.listing]).toEqual([
      ["contact:people/c1", "contact:people/c2"],
      { first: true, ended: "complete" },
    ]);
  });

  it("a kill between pages: a failed call hands over nothing, and the same cursor then gives the page", async () => {
    const fake = fakeContacts([person(1), person(2)], { now, pageSize: 1 });
    const connector = fake.connector(sourceAccount);
    const first = await connector.listChanges(account, null, 10);
    fake.failAt(2, "unavailable");
    await expect(connector.listChanges(account, first.next, 10)).rejects.toMatchObject({ code: "unavailable" });
    expect(ids(await connector.listChanges(account, first.next, 10))).toEqual(["contact:people/c2"]);
  });

  it("an unreadable contact is skipped, and a burst of them fails the page", async () => {
    const broken = (n: number) => ({ ...person(n), names: "not a list" });
    const one = fakeContacts([person(1), broken(2)], { now }).connector(sourceAccount);
    expect((await one.listChanges(account, null, 10)).skipped).toEqual([
      { sourceItemId: "contact:people/c2", reason: "unsupported" },
    ]);
    const burst = fakeContacts([1, 2, 3, 4, 5, 6].map(broken), { now }).connector(sourceAccount);
    await expect(burst.listChanges(account, null, 10)).rejects.toMatchObject({ code: "bad_response" });
  });

  it("fakeSources gives a fake only to the labels it names, and another label refuses google_contacts", () => {
    const w = world({ now: new Date(now) });
    const [personal, work] = fakeSources(w, { contacts: ["personal"] });
    expect(() => personal!.connector("google_contacts", sourceAccount, {})).not.toThrow();
    expect(() => work!.connector("google_contacts", sourceAccount, {})).toThrow(
      expect.objectContaining({ code: "off_allowlist" }),
    );
    const [none] = fakeSources(w);
    expect(() => none!.connector("google_contacts", sourceAccount, {})).toThrow(
      expect.objectContaining({ code: "off_allowlist" }),
    );
  });
});
