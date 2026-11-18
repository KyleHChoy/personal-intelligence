import { type EntityId, SearchResult } from "@intelligence/contracts/personal";
import type { Person } from "@intelligence/personal-core/items";
import { afterAll, describe, expect, it } from "vitest";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { daysFrom, instant, outcomeValue, registration } from "../test-support/values.ts";
import { type StoreSeeder, storeSeeder } from "../test-support/world.ts";

// Every name and address is hand-written, on reserved domains. No name holds a hyphen or other
// punctuation where the rule's "word" would have to be guessed at.

const NOW = new Date("2026-03-10T12:00:00.000Z");
const OWNER = "owner.search@example.com";

const PEOPLE = {
  marisol: { name: "Marisol Quillfeather", address: "marisol.q@example.com" },
  // Composed characters: the query must find the person without them.
  zoe: { name: "Zoë Brémont", address: "z.b@example.com" },
  ines: { name: "Ines Tidewater", address: "ines@harbor.example.org" },
  odile: { name: "Odile Tidewater", address: "odile@harbor.example.org" },
  // The ranking cast, for the query "rowan".
  exact: { name: "Rowan", address: "r.exact@example.com" },
  prefixFirst: { name: "Rowan Ashdown", address: "rowan.ashdown@example.com" },
  prefixLater: { name: "Dana Rowanberry", address: "dana.r@example.com" },
  substring: { name: "Kit Pellwick", address: "kit.mcrowan@example.com" },
  tiedOne: { name: "Lee Sparrow", address: "lee@rowanworks.example.org" },
  tiedTwo: { name: "Noor Finch", address: "noor@rowanworks.example.org" },
  // "rowan" inside a word of a name, and nowhere in the address: no match.
  inside: { name: "Shay Mcrowan", address: "shay.m@example.com" },
  // "rowan" in the address, and no mail of its own: only ever copied, on six messages.
  copied: { name: "Tovi Brackwater", address: "tovi.rowanne@example.com" },
  limitSender: { name: "Vesper Sender", address: "vesper@example.com" },
} satisfies Record<string, Required<Person>>;

// How many messages each person sent the owner: the count that ranks within a match class.
const SENT: Record<keyof typeof PEOPLE, number> = {
  marisol: 1,
  zoe: 1,
  ines: 2,
  odile: 1,
  exact: 1,
  prefixFirst: 3,
  prefixLater: 2,
  substring: 5,
  tiedOne: 1,
  tiedTwo: 1,
  inside: 6,
  copied: 0,
  limitSender: 1,
};

// Twenty-seven people who share one word of their names, seen only as co-recipients of one
// message: more than a search may return, all with no direct mail.
const CROWD: Required<Person>[] = Array.from({ length: 27 }, (_, n) => ({
  name: `Limitcase Member${String(n).padStart(2, "0")}`,
  address: `crowd${String(n).padStart(2, "0")}@example.com`,
}));

// Two people the source named two ways. Avery's later name was also stored later; Briar's
// latest name was stored first, and an older message that shows it again was stored last.
const RENAMED = {
  avery: { address: "avery.twonames@example.com", older: "Avery Oldname", latest: "Avery Newname" },
  briar: { address: "briar.twonames@example.com", older: "Briar Formername", latest: "Briar Currentname" },
};

let store: TestStore | undefined;
let seed: StoreSeeder;
let token = "";

const search = async (query: string, limit?: number) =>
  SearchResult.parse(
    outcomeValue(await (store as TestStore).reader.search(token, { query, ...(limit === undefined ? {} : { limit }) })),
  ).results;
const idOf = (person: keyof typeof PEOPLE): EntityId => seed.entityOf(PEOPLE[person].address);
const sorted = (ids: string[]): string[] => [...ids].sort();
// The latest message each person sent, as seeded below.
const lastSent = (person: keyof typeof PEOPLE): number =>
  daysFrom(NOW, -(Object.keys(PEOPLE).indexOf(person) + 1)).getTime();

// The store is seeded once, by the first test that asks, and only read after that. Every test
// awaits it, so a failure to seed fails each test and skips none.
let seeded: Promise<void> | undefined;
const ready = (): Promise<void> => (seeded ??= prepare());
const prepare = async (): Promise<void> => {
  store = await openStore({ compartments: ["own"], now: NOW });
  seed = storeSeeder(store.writer, NOW);
  const mail = await store.writer.ensureSourceAccount("personal", "google_mail", "own", OWNER);
  const owner: Person = { address: OWNER };
  for (const [index, [key, person]] of Object.entries(PEOPLE).entries()) {
    for (let n = 0; n < SENT[key as keyof typeof PEOPLE]; n += 1) {
      // Each person's messages are a day apart from the next person's, the first the latest.
      // Every message of Shay's is copied to Tovi.
      const cc = key === "inside" ? { cc: [PEOPLE.copied] } : {};
      await seed.mail(mail, {
        id: `search-${key}-${n}`,
        from: person,
        to: [owner],
        ...cc,
        at: daysFrom(NOW, -(index + 1) - n * 20),
        subject: `canary-subject-${key}-${n}`,
      });
    }
  }
  await seed.mail(mail, {
    id: "search-crowd",
    from: PEOPLE.limitSender,
    to: [owner],
    cc: CROWD,
    at: daysFrom(NOW, -40),
    subject: "canary-subject-crowd",
  });
  const named = (address: string, name: string, id: string, days: number) =>
    seed.mail(mail, {
      id,
      from: { address, name },
      to: [owner],
      at: daysFrom(NOW, days),
      subject: `canary-subject-${id}`,
    });
  await named(RENAMED.avery.address, RENAMED.avery.older, "search-avery-0", -70);
  await named(RENAMED.avery.address, RENAMED.avery.latest, "search-avery-1", -60);
  await named(RENAMED.briar.address, RENAMED.briar.latest, "search-briar-0", -60);
  await named(RENAMED.briar.address, RENAMED.briar.older, "search-briar-1", -70);
  await named(RENAMED.briar.address, RENAMED.briar.latest, "search-briar-2", -80);
  ({ token } = await store.admin.clients.addClient(registration("search-client", ["own"])));
};

afterAll(async () => {
  await store?.close();
});

describe("search", { timeout: 180_000 }, () => {
  it("a first name finds the person", async () => {
    await ready();
    const expected = [
      {
        id: idOf("marisol"),
        kind: "person",
        name: { untrusted: PEOPLE.marisol.name },
        address: { untrusted: PEOPLE.marisol.address },
        lastInteractionAt: lastSent("marisol"),
      },
    ];
    for (const query of ["marisol", "Marisol", "MARISOL", "mari"]) {
      const found = await search(query);
      expect(
        found.map((one) => ({ ...one, lastInteractionAt: instant(one.lastInteractionAt) })),
        query,
      ).toEqual(expected);
    }
    // A later word of the name, and the whole name of several words.
    expect((await search("quillfeather")).map((one) => one.id)).toEqual([idOf("marisol")]);
    expect((await search("marisol quillfeather")).map((one) => one.id)).toEqual([idOf("marisol")]);
    // The positive control's other side: a name nobody has finds nobody, and a subject is not a name.
    expect(await search("nobody")).toEqual([]);
    expect(await search("canary")).toEqual([]);
  });

  it("an accented name is found without its accent", async () => {
    await ready();
    for (const query of ["zoe", "bremont", "zoe bremont", "Zoë", "BRÉMONT", "zoe\u0308 bre\u0301mont"]) {
      const found = await search(query);
      expect(
        found.map((one) => one.id),
        query,
      ).toEqual([idOf("zoe")]);
      // The name comes back as it was written.
      expect(found[0]?.name, query).toEqual({ untrusted: PEOPLE.zoe.name });
    }
  });

  it("a domain finds its people", async () => {
    await ready();
    for (const query of ["harbor.example.org", "HARBOR.example.org", "harbor.exam"]) {
      const found = await search(query);
      // Ines has two messages and Odile one; the organization's count is 0, so it is last.
      expect(
        found.map((one) => [one.kind, one.name?.untrusted ?? null, one.address?.untrusted]),
        query,
      ).toEqual([
        ["person", PEOPLE.ines.name, PEOPLE.ines.address],
        ["person", PEOPLE.odile.name, PEOPLE.odile.address],
        ["organization", null, "harbor.example.org"],
      ]);
      expect(found.map((one) => one.id).slice(0, 2), query).toEqual([idOf("ines"), idOf("odile")]);
      expect(found[2]?.lastInteractionAt, query).toBeNull();
    }
    // The positive control: another domain finds none of them.
    const elsewhere = (await search("rowanworks.example.org")).map((one) => one.id);
    expect(elsewhere).toHaveLength(3);
    expect(elsewhere).not.toContain(idOf("ines"));
    expect(elsewhere).not.toContain(idOf("odile"));
  });

  it("a whole address finds its person", async () => {
    await ready();
    for (const query of [PEOPLE.marisol.address, PEOPLE.marisol.address.toUpperCase()]) {
      expect(
        (await search(query)).map((one) => one.id),
        query,
      ).toEqual([idOf("marisol")]);
    }
    expect((await search(PEOPLE.zoe.address)).map((one) => one.id)).toEqual([idOf("zoe")]);
    // An address nobody has finds nobody, and the owner is never a result.
    expect(await search("marisol.q@example.net")).toEqual([]);
    expect(await search(OWNER)).toEqual([]);
    expect(await search("owner.search")).toEqual([]);
  });

  it("results rank by exact name, then word prefix, then substring, then visible interaction count, then id", async () => {
    await ready();
    const found = await search("rowan");
    const organization = found.find((one) => one.kind === "organization");
    expect(organization?.address).toEqual({ untrusted: "rowanworks.example.org" });
    expect(found.map((one) => one.id)).toEqual([
      // The whole name, with the fewest messages of all.
      idOf("exact"),
      // A prefix of a word of the name: three messages, then two.
      idOf("prefixFirst"),
      idOf("prefixLater"),
      // A substring of an address: five messages, then two people with one each, by id. Then
      // those whose count is 0, by id: the organization, and Tovi, who is on six messages and
      // was only ever copied on them. A co-recipient row counts for nothing in the rank.
      idOf("substring"),
      ...sorted([idOf("tiedOne"), idOf("tiedTwo")]),
      ...sorted([idOf("copied"), organization?.id ?? ""]),
    ]);
    expect(found.find((one) => one.id === idOf("copied"))?.lastInteractionAt).not.toBeNull();
    // "rowan" inside a word of a name is no match, though that person has more mail than most.
    expect(found.map((one) => one.id)).not.toContain(idOf("inside"));
    expect((await search("mcrowan")).map((one) => one.id)).toEqual([idOf("inside"), idOf("substring")]);

    // The whole name of several words is a match, and so is a piece of the address.
    expect((await search("rowan ashdown")).map((one) => one.id)).toEqual([idOf("prefixFirst")]);
    expect((await search("rowan.a")).map((one) => one.id)).toEqual([idOf("prefixFirst")]);
  });

  it("a result's name is the alias whose evidence is latest, and every name of a person finds them", async () => {
    await ready();
    for (const person of [RENAMED.avery, RENAMED.briar]) {
      const expected = [
        {
          id: seed.entityOf(person.address),
          name: { untrusted: person.latest },
          address: { untrusted: person.address },
        },
      ];
      // By the latest name, by the older one, by a word of each, and by the address.
      const [, olderWord] = person.older.toLowerCase().split(" ");
      const [, latestWord] = person.latest.toLowerCase().split(" ");
      for (const query of [person.latest, person.older, olderWord ?? "", latestWord ?? "", person.address]) {
        expect(
          (await search(query)).map(({ id, name, address }) => ({ id, name, address })),
          query,
        ).toEqual(expected);
      }
    }
    // The order they were stored in is not what decides: one's latest name was stored last, the
    // other's first.
    const stored = await queryAs<{ address: string; names: string[] }>(
      (store as TestStore).db.urls.admin,
      `select a.value_fp as address, array_agg(s.value_fp order by s.id) as names
       from knowledge.aliases s join knowledge.accounts a on a.entity_id = s.entity_id
       where a.entity_id = any($1) group by a.value_fp order by a.value_fp`,
      [[seed.entityOf(RENAMED.avery.address), seed.entityOf(RENAMED.briar.address)]],
    );
    const { keys } = (store as TestStore).db;
    const prints = (person: typeof RENAMED.avery, order: ("older" | "latest")[]) => ({
      address: fingerprint(keys, "address", person.address),
      names: order.map((which) => fingerprint(keys, "name", person[which])),
    });
    expect(stored).toEqual(
      [prints(RENAMED.avery, ["older", "latest"]), prints(RENAMED.briar, ["latest", "older", "latest"])].sort((a, b) =>
        a.address < b.address ? -1 : 1,
      ),
    );
  });

  it("store: `limit` caps the results", async () => {
    await ready();
    const crowd = sorted(CROWD.map((person) => seed.entityOf(person.address)));
    // All twenty-seven match by a word prefix and have no direct mail, so they rank by id; a
    // search returns at most 25.
    const all = (await search("limitcase")).map((one) => one.id);
    expect(all).toEqual(crowd.slice(0, 25));
    expect((await search("limitcase", 25)).map((one) => one.id)).toEqual(crowd.slice(0, 25));
    expect((await search("limitcase", 3)).map((one) => one.id)).toEqual(crowd.slice(0, 3));
    expect((await search("limitcase", 1)).map((one) => one.id)).toEqual(crowd.slice(0, 1));
    // The positive control: a limit above the matches returns them all.
    expect((await search("rowan", 25)).length).toBe(8);
  });
});
